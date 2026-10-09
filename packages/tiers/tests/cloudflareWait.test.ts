import { expect, test } from "bun:test"
import type { Page } from "patchright"
import { routeChallengeWait } from "../src/utils/challengeRouter"
import { attemptTurnstileClick, waitForChallengeResolution } from "../src/utils/challengeWait"

const wall =
  '<html><head><title>Just a moment...</title></head><body id="challenge-form">Checking your browser</body></html>'
const destination = "<html><head><title>Article</title></head><body><article>Requested content</article></body></html>"

function pageFixture() {
  return {
    title: async () => "Just a moment...",
    content: async () => wall,
    url: () => "https://example.test/article",
    frames: () => [],
    context: () => ({ cookies: async () => [{ name: "cf_clearance", domain: "example.test" }] }),
    keyboard: { press: async () => {} },
    waitForLoadState: async () => {},
    goto: async () => {},
  }
}

test("Cloudflare routing reads the latest main-document headers after navigation", async () => {
  const page = pageFixture()
  let navigated = false
  page.title = async () => {
    navigated = true
    return "Article"
  }
  page.content = async () => destination
  const headers = (): Record<string, string> => (navigated ? {} : { "cf-mitigated": "challenge" })
  const result = await routeChallengeWait(
    page as unknown as Page,
    wall,
    headers(),
    1500,
    page.url(),
    undefined,
    403,
    undefined,
    headers,
  )
  expect(result).toEqual({ challengeType: "cloudflare-interstitial", resolution: "ok" })
})

test("clearance and a completed goto do not declare a persistent wall solved", async () => {
  const page = pageFixture()
  let navigations = 0
  page.goto = async () => {
    navigations++
  }
  const result = await waitForChallengeResolution(page as unknown as Page, 6500, page.url())
  expect(navigations).toBe(1)
  expect(result).toBe("timeout")
}, 8000)

test("manual clearance recovery confirms the destination without waiting for network idle", async () => {
  const page = pageFixture()
  let recovered = false
  const loadStates: string[] = []
  page.goto = async () => {
    recovered = true
  }
  page.title = async () => (recovered ? "Article" : "Just a moment...")
  page.content = async () => (recovered ? destination : wall)
  page.waitForLoadState = async (state?: string) => {
    loadStates.push(state ?? "load")
  }
  const result = await waitForChallengeResolution(page as unknown as Page, 7500, page.url())
  expect(result).toBe("ok")
  expect(loadStates).not.toContain("networkidle")
}, 9000)

test("settled content does not trigger a keyboard click for a provider link", async () => {
  const page = pageFixture()
  let presses = 0
  page.title = async () => "Article"
  page.content = async () =>
    destination.replace("</article>", '<a href="https://challenges.cloudflare.com/turnstile">Docs</a></article>')
  page.keyboard.press = async () => {
    presses++
  }
  expect(await waitForChallengeResolution(page as unknown as Page, 1500, page.url())).toBe("ok")
  expect(presses).toBe(0)
})

test("shadow traversal visits each subtree once and releases browser handles", async () => {
  let evaluations = 0
  let released = 0
  let roots = 0
  const shadow = { children: [], querySelectorAll: () => [] }
  function node(child?: object, shadowRootUnl?: object): object {
    return {
      children: child ? [child] : [],
      shadowRootUnl,
      querySelectorAll() {
        evaluations++
        const descendants = []
        let current = child as { children: object[] } | undefined
        while (current) {
          descendants.push(current)
          current = current.children[0] as typeof current
        }
        return descendants
      },
    }
  }
  let tree = node(undefined, shadow)
  for (let i = 0; i < 8; i++) tree = node(tree)
  const frame = {
    url: () => "https://challenges.cloudflare.com/turnstile/widget",
    async evaluateHandle(callback: () => unknown[]) {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
      Object.defineProperty(globalThis, "document", { configurable: true, value: tree })
      try {
        roots = callback().length
      } finally {
        if (descriptor) Object.defineProperty(globalThis, "document", descriptor)
        else Reflect.deleteProperty(globalThis, "document")
      }
      return {
        getProperties: async () => new Map(),
        dispose: async () => {
          released++
        },
      }
    },
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
    frameElement: async () => undefined,
  }
  const page = { frames: () => [frame], content: async () => "" }
  expect(await attemptTurnstileClick(page as unknown as Page, false)).toBe(false)
  expect(roots).toBe(1)
  expect(evaluations).toBeLessThanOrEqual(9)
  expect(released).toBe(1)
})

test("Cloudflare deny URLs remain blocked even without an active widget", async () => {
  const page = pageFixture()
  page.url = () => "https://example.test/cdn-cgi/error/1020"
  page.title = async () => "Error"
  page.content = async () => "<html><title>Error</title><body>Forbidden</body></html>"
  expect(await waitForChallengeResolution(page as unknown as Page, 1500, page.url())).toBe("ip-blocked")
})
