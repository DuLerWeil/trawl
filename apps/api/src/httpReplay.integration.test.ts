import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type BrowserHandle, MemorySessionCache } from "@trawl/browser"
import type { OrchestratorDeps } from "@trawl/tiers"
import { Elysia } from "elysia"
import { launchAnubisBrowser } from "../../../packages/browser/tests/helpers/anubisBrowser"
import { MetricsStore } from "./metrics"
import { scrapeRoute } from "./routes/scrape"
import { v1Route } from "./routes/v1"

describe.skipIf(process.env.TRAWL_HTTP_REPLAY_TESTS !== "1")("verified generic HTTP sessions", () => {
  let browser: Awaited<ReturnType<typeof launchAnubisBrowser>>
  let handle: BrowserHandle
  let origin: ReturnType<typeof Bun.serve>
  const content = '<h1>Verified application content</h1><a href="/correct">Details</a>'

  beforeAll(async () => {
    origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname
        if (path === "/app.js")
          return new Response(`document.querySelector('#app').innerHTML = ${JSON.stringify(content)}`, {
            headers: { "content-type": "application/javascript" },
          })
        if (!request.headers.get("cookie")?.includes("session=owned")) {
          return new Response(
            '<html><head><title>Just a moment...</title></head><body><script>document.cookie="session=owned; Path=/";location.reload()</script></body></html>',
            { headers: { "content-type": "text/html" } },
          )
        }
        return new Response(
          `<html><head><title>Owned application</title></head><body><nav>Site navigation</nav><main id="app">${path === "/static" ? content : ""}</main><script src="/app.js"></script></body></html>`,
          { headers: { "content-type": "text/html", "cache-control": "no-store" } },
        )
      },
    })
    browser = await launchAnubisBrowser()
    const context = await browser.newContext()
    const page = await context.newPage()
    const userAgent = await page.evaluate(() => navigator.userAgent)
    await page.close()
    handle = {
      id: 1,
      lease: 1,
      headful: false,
      browser,
      context,
      fingerprint: { userAgent, platform: "Linux x86_64", locale: "en-US", timezone: "UTC" },
    }
  }, 120000)

  afterAll(async () => {
    await browser?.close()
    origin?.stop(true)
  })

  for (const route of ["/scrape", "/v1"] as const) {
    for (const path of ["/static", "/dynamic"] as const) {
      test(`${route} reuses complete HTTP content and retains browser rendering for ${path}`, async () => {
        const cache = new MemorySessionCache({ ttlSeconds: 60 })
        let checkouts = 0
        let lastTier = 0
        const deps: OrchestratorDeps = {
          acquireBrowser: async () => {
            checkouts++
            return handle
          },
          releaseBrowser: () => {},
          loadSession: (domain) => cache.load(domain),
          saveSession: (domain, data) => cache.save(domain, data),
          invalidateSession: (domain) => cache.invalidate(domain),
          onTierAttempt: (attempt) => {
            lastTier = attempt.tier
          },
        }
        const metrics = new MetricsStore()
        const app = new Elysia()
          .use(
            scrapeRoute(
              () => deps,
              () => true,
              metrics,
            ),
          )
          .use(v1Route({ orchestratorDeps: () => deps, poolReady: () => true, metricsStore: metrics }))
        const send = async () => {
          const response = await app.handle(
            new Request(`http://localhost${route}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                url: `http://127.0.0.1:${origin.port}${path}`,
                cmd: "request.get",
                maxTimeout: 10000,
                solveEmbeddedCaptchas: false,
              }),
            }),
          )
          const result = await response.json()
          expect(response.status).toBe(200)
          expect(route === "/scrape" ? result.html : result.solution.response).toContain(content)
        }
        await send()
        expect(checkouts).toBe(1)
        await send()
        expect(lastTier).toBe(path === "/static" ? 1 : 2)
        expect(checkouts).toBe(path === "/static" ? 1 : 2)
      }, 25000)
    }
  }
})
