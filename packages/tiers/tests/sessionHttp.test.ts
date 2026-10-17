import { afterEach, describe, expect, test } from "bun:test"
import type { BrowserHandle } from "@trawl/browser"
import type { Cookie, ScrapeRequest, SessionData } from "@trawl/types"
import { type OrchestratorDeps, scrape } from "../src/orchestrator"
import { runTier1 } from "../src/tiers/1"
import { HttpSessionCookies } from "../src/utils/httpSessionCookies"
import { ProxyPool } from "../src/utils/proxyRotator"

let server: ReturnType<typeof Bun.serve> | undefined
afterEach(() => server?.stop(true))

function clearance(domain = "example.test", extra: Partial<Cookie> = {}): Cookie {
  return {
    name: "cf_clearance",
    value: "verified",
    domain,
    path: "/",
    expires: Date.now() / 1000 + 3600,
    secure: true,
    httpOnly: true,
    ...extra,
  }
}

function cached(cookies = [clearance()]): SessionData {
  return { cookies, userAgent: "cached-agent", savedAt: Date.now(), httpOrigin: "https://example.test" }
}

describe("HTTP clearance boundaries", () => {
  test.each([
    "techaro.lol-anubis-auth",
    "techaro.lol-anubis",
    "techaro.lol-anubis-a1b2c3d4",
    "techaro.lol-anubis-auth-a1b2c3d4",
  ])("accepts browser-verified Anubis auth cookie %s with the same origin restrictions", (name) => {
    const session = cached([clearance("example.test", { name })])
    expect(HttpSessionCookies.from(session, "https://example.test/")?.header("https://example.test/")).toBe(
      `${name}=verified`,
    )
    expect(HttpSessionCookies.from(session, "https://other.test/")).toBeUndefined()
    expect(HttpSessionCookies.from({ ...session, httpOrigin: undefined }, "https://example.test/")).toBeUndefined()
    expect(
      HttpSessionCookies.from(cached([clearance("example.test", { name, expires: 1 })]), "https://example.test/"),
    ).toBeUndefined()
  })

  test.each([
    "techaro.lol-anubis-cookie-verification",
    "techaro.lol-anubis-original-referer",
    "techaro.lol-anubis-cookie-verification-a1b2c3d4",
  ])("does not treat %s as Anubis clearance", (name) => {
    expect(
      HttpSessionCookies.from(cached([clearance("example.test", { name })]), "https://example.test/"),
    ).toBeUndefined()
  })

  test("honors host-only/domain cookies, paths, expiry, secure transport and longest path first", () => {
    const jar = HttpSessionCookies.from(
      cached([
        clearance(),
        clearance(".example.test", { name: "parent" }),
        clearance("child.example.test", { name: "child" }),
        clearance("other.test", { name: "unrelated" }),
        clearance("example.test", { name: "expired", expires: 1 }),
        clearance("example.test", { name: "scoped", path: "/a" }),
      ]),
      "https://example.test/a/b",
    )
    expect(jar?.header("https://example.test/a/b")).toBe("scoped=verified; cf_clearance=verified; parent=verified")
    expect(jar?.header("https://example.test/ab")).toBe("cf_clearance=verified; parent=verified")
    expect(() => jar?.header("https://child.example.test/")).toThrow("session-redirect-needs-browser")
    expect(() => jar?.header("http://example.test/")).toThrow("session-redirect-needs-browser")
    expect(
      HttpSessionCookies.from(cached([clearance("example.test", { expires: 1 })]), "https://example.test/"),
    ).toBeUndefined()
    expect(HttpSessionCookies.from({ ...cached(), httpOrigin: undefined }, "https://example.test/")).toBeUndefined()
    expect(HttpSessionCookies.from(cached(), "https://example.test:8443/")).toBeUndefined()
  })

  test("rotates and deletes cookies without changing the saved session or accepting foreign domains", () => {
    const session = cached([clearance(), clearance("example.test", { name: "remove" })])
    const jar = HttpSessionCookies.from(session, "https://example.test/")
    if (!jar) throw new Error("Expected a usable clearance")
    const headers = new Headers()
    headers.append("set-cookie", "cf_clearance=rotated; Path=/; Secure; HttpOnly; Max-Age=60")
    headers.append("set-cookie", "remove=; Path=/; Max-Age=0; Expires=Wed, 21 Oct 2037 07:28:00 GMT")
    headers.append("set-cookie", "scoped=path; HttpOnly")
    headers.append("set-cookie", "foreign=secret; Domain=other.test; Path=/")
    jar.update(headers, "https://example.test/a/b")
    expect(jar.header("https://example.test/a/c")).toBe("scoped=path; cf_clearance=rotated")
    expect(jar.header("https://example.test/")).toBe("cf_clearance=rotated")
    expect(jar.snapshot().find((cookie) => cookie.name === "cf_clearance")).toMatchObject({
      secure: true,
      httpOnly: true,
    })
    expect(session.cookies).toHaveLength(2)
    expect(session.cookies[0]?.value).toBe("verified")
  })

  test("returns partitioned or unverified parent-domain cookie policies to the browser", () => {
    const jar = HttpSessionCookies.from(cached(), "https://example.test/")
    if (!jar) throw new Error("Expected a usable clearance")
    expect(() =>
      jar.update(new Headers({ "set-cookie": "a=b; Partitioned; Secure" }), "https://example.test/"),
    ).toThrow("session-cookies-need-browser")
    expect(() =>
      jar.update(new Headers({ "set-cookie": "a=b; Domain=test; Path=/" }), "https://example.test/"),
    ).toThrow("session-cookies-need-browser")
  })

  test("recomputes cookies on each redirect, applies rotation, and refuses a different origin before contacting it", async () => {
    const seen: (string | null)[] = []
    server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push(request.headers.get("cookie"))
        switch (new URL(request.url).pathname) {
          case "/a/start":
            return new Response(null, {
              status: 302,
              headers: { location: "/done", "set-cookie": "cf_clearance=new; Path=/" },
            })
          case "/away":
            return Response.redirect(`http://localhost:${new URL(request.url).port}/leaked`)
          default:
            return new Response("<html><body>Actual content</body></html>", {
              headers: { "content-type": "text/html" },
            })
        }
      },
    })
    const origin = `http://127.0.0.1:${server.port}`
    const session = {
      ...cached([
        clearance("127.0.0.1", { secure: false }),
        clearance("127.0.0.1", { name: "scoped", path: "/a", secure: false }),
      ]),
      httpOrigin: origin,
    }
    const jar = HttpSessionCookies.from(session, `${origin}/a/start`)
    if (!jar) throw new Error("Expected a usable clearance")
    const result = await runTier1(
      `${origin}/a/start`,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      jar,
    )
    expect(result).toMatchObject({ status: "success", effectiveUrl: `${origin}/done` })
    expect(seen).toEqual(["scoped=verified; cf_clearance=verified", "cf_clearance=new"])
    const refused = await runTier1(
      `${origin}/away`,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      jar,
    )
    expect(refused).toMatchObject({ status: "error", reason: "session-redirect-needs-browser" })
    expect(seen).toHaveLength(3)
  })
})

describe("HTTP clearance fallback", () => {
  const html = "<html><body>Actual content</body></html>"
  const success = { status: "success" as const, durationMs: 1, html, effectiveUrl: "https://example.test/" }

  test.each([
    [
      "rejected Anubis clearance",
      '<html><script id="anubis_challenge" type="application/json">{}</script><title>Making sure you are not a bot!</title></html>',
    ],
    ["rejected clearance", "<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>"],
    ["embedded Turnstile", '<html><body><div class="cf-turnstile" data-sitekey="site"></div></body></html>'],
    [
      "JavaScript application shell",
      '<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>',
    ],
  ])("keeps browser solving for %s", async (_name, wall) => {
    server = Bun.serve({ port: 0, fetch: () => new Response(wall, { headers: { "content-type": "text/html" } }) })
    const origin = `http://127.0.0.1:${server.port}`
    let checkouts = 0
    const deps: OrchestratorDeps = {
      acquireBrowser: async () => {
        checkouts++
        return {} as BrowserHandle
      },
      releaseBrowser: () => {},
      loadSession: async () => ({ ...cached([clearance("127.0.0.1", { secure: false })]), httpOrigin: origin }),
      saveSession: async () => {},
      invalidateSession: async () => {},
    }
    const result = await scrape({ url: origin, maxTier: 2 }, deps, { tier2: async () => ({ ...success, tier: 2 }) })
    expect(result.tier).toBe(2)
    expect(result.timings.map((timing) => timing.status)).toEqual(["needs-js", "success"])
    expect(checkouts).toBe(1)
  })

  test.each([
    { name: "POST", request: { method: "POST", headers: { "Content-Type": "text/plain" }, body: "body" } },
    { name: "skipHttp", request: { skipHttp: true } },
    { name: "explicit proxy", request: { proxy: "http://proxy.test:8080" } },
    { name: "screenshot", request: { screenshot: true } },
    { name: "content selector", request: { contentWaitForSelector: "#loaded" } },
    { name: "response capture", request: { captureResponses: ["/api/"] } },
    { name: "MHTML", request: { mhtml: true } },
    { name: "TLS opt-out", request: { ignoreCertificateErrors: true } },
    { name: "imported cookies", request: { cookies: [{ name: "login", value: "private" }] } },
  ] satisfies { name: string; request: Partial<ScrapeRequest> }[])(
    "preserves the browser path for $name",
    async ({ request: options }) => {
      let replay = false
      const deps: OrchestratorDeps = {
        acquireBrowser: async () => ({ fingerprint: { userAgent: "browser-agent" } }) as BrowserHandle,
        releaseBrowser: () => {},
        loadSession: async () => cached(),
        saveSession: async () => {},
        invalidateSession: async () => {},
      }
      await scrape({ url: "https://example.test/", maxTier: 3, ...options }, deps, {
        tier1: async (...args) => {
          replay = Boolean(args[9])
          return { tier: 1, status: "needs-js", durationMs: 1 }
        },
        tier2: async () => ({ ...success, tier: 2 }),
        tier3: async () => ({ ...success, tier: 3 }),
      })
      expect(replay).toBe(false)
    },
  )

  test("does not replay clearance through a different configured egress", async () => {
    let replay = false
    await scrape(
      { url: "https://example.test/", maxTier: 1 },
      {
        acquireBrowser: async () => {
          throw new Error("Unexpected browser checkout")
        },
        releaseBrowser: () => {},
        loadSession: async () => cached(),
        saveSession: async () => {},
        invalidateSession: async () => {},
        proxyPool: new ProxyPool(["http://proxy.test:8080"]),
      },
      {
        tier1: async (...args) => {
          replay = Boolean(args[9])
          return { ...success, tier: 1 }
        },
      },
    )
    expect(replay).toBe(false)
  })

  test("bounds an unresponsive HTTP replay and leaves time for browser fallback", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    const origin = `http://127.0.0.1:${server.port}`
    let remaining = 0
    const result = await scrape(
      { url: origin, maxTier: 2, maxTimeout: 900 },
      {
        acquireBrowser: async (_domain, budgetMs) => {
          remaining = budgetMs ?? 0
          return {} as BrowserHandle
        },
        releaseBrowser: () => {},
        loadSession: async () => ({ ...cached([clearance("127.0.0.1", { secure: false })]), httpOrigin: origin }),
        saveSession: async () => {},
        invalidateSession: async () => {},
      },
      { tier2: async () => ({ ...success, tier: 2 }) },
    )
    expect(result.tier).toBe(2)
    expect(result.timings[0]?.status).toBe("error")
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThan(800)
  })
})

test.each(["cf_clearance", "techaro.lol-anubis-auth"])(
  "reuses verified %s over HTTP without checking out a browser",
  async (name) => {
    const seen: { cookie: string | null; agent: string | null }[] = []
    server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.push({ cookie: request.headers.get("cookie"), agent: request.headers.get("user-agent") })
        if (!request.headers.get("cookie")?.includes(`${name}=verified`)) {
          return new Response("<html><title>Just a moment...</title><script>window._cf_chl_opt={}</script></html>", {
            status: 403,
            headers: { "content-type": "text/html" },
          })
        }
        return new Response(
          '<html><head><script src="/enhance.js"></script></head><body>Actual destination</body></html>',
          {
            headers: { "content-type": "text/html", "set-cookie": "fresh=value; Path=/; HttpOnly" },
          },
        )
      },
    })
    const url = `http://127.0.0.1:${server.port}/`
    let saved: SessionData | undefined
    let checkouts = 0
    const deps: OrchestratorDeps = {
      acquireBrowser: async () => {
        checkouts++
        return { fingerprint: { userAgent: "browser-agent" } } as BrowserHandle
      },
      releaseBrowser: () => {},
      loadSession: async () => saved,
      saveSession: async (_domain, data) => {
        saved = data
      },
      invalidateSession: async () => {
        saved = undefined
      },
    }
    await scrape({ url, maxTier: 3 }, deps, {
      tier3: async () => ({
        tier: 3,
        status: "success",
        durationMs: 1,
        html: "<html><body>Actual destination</body></html>",
        effectiveUrl: url,
        userAgent: "browser-agent",
        cookies: [
          {
            name,
            value: "verified",
            domain: "127.0.0.1",
            path: "/",
            expires: Date.now() / 1000 + 3600,
            secure: false,
            httpOnly: true,
          },
        ],
      }),
    })
    const result = await scrape({ url, maxTier: 1 }, deps)
    expect(result).toMatchObject({ tier: 1, sessionCached: true, userAgent: "browser-agent" })
    expect(result.html).toContain("Actual destination")
    expect(result.cookies.map((cookie) => cookie.name)).toEqual([name, "fresh"])
    expect(saved?.cookies).toEqual(result.cookies)
    expect(checkouts).toBe(1)
    expect(seen).toHaveLength(2)
    expect(seen[1]).toEqual({ cookie: `${name}=verified`, agent: "browser-agent" })
  },
)
