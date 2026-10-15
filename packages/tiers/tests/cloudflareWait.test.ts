import { expect, test } from "bun:test"
import type { Page } from "patchright"
import { solveTurnstile } from "../src/solvers/turnstile"
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
    frames: (): unknown[] => [],
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

test.each(["", " \n ", undefined])("Cloudflare does not clear an unreadable or empty document (%s)", async (html) => {
  const page = pageFixture()
  page.title = async () => "Article"
  page.content = async () => {
    if (html === undefined) throw new Error("Document changed during navigation")
    return html
  }
  expect(await waitForChallengeResolution(page as unknown as Page, 900, page.url())).toBe("timeout")
})

test("Cloudflare clearance from a suffix sibling cannot trigger recovery navigation", async () => {
  const page = pageFixture()
  page.url = () => "https://notexample.test/article"
  let navigations = 0
  page.goto = async () => {
    navigations++
  }
  expect(await waitForChallengeResolution(page as unknown as Page, 6500, page.url())).toBe("timeout")
  expect(navigations).toBe(0)
}, 8000)

function clickableFrame(click: () => Promise<void>) {
  return {
    url: () => "https://challenges.cloudflare.com/turnstile/widget",
    evaluateHandle: async () => {
      throw new Error("Shadow root unavailable")
    },
    locator: () => ({ first: () => ({ isVisible: async () => true, click }) }),
  }
}

test.each(["clicked", "hidden", "detached"])(
  "coordinate fallback releases its iframe handle when %s",
  async (state) => {
    let disposed = 0
    let clicked = 0
    const frame = {
      url: () => "https://challenges.cloudflare.com/turnstile/widget",
      evaluateHandle: async () => {
        throw new Error("Shadow root unavailable")
      },
      locator: () => ({ first: () => ({ isVisible: async () => false }) }),
      frameElement: async () => ({
        boundingBox: async () => {
          if (state === "detached") throw new Error("Frame detached")
          return state === "hidden" ? null : { x: 0, y: 0, width: 300, height: 65 }
        },
        dispose: async () => {
          disposed++
        },
      }),
    }
    const page = {
      frames: () => [frame],
      mouse: {
        move: async () => {},
        click: async () => {
          clicked++
        },
      },
    }
    expect(await attemptTurnstileClick(page as unknown as Page, false)).toBe(state === "clicked")
    expect(clicked).toBe(state === "clicked" ? 1 : 0)
    expect(disposed).toBe(1)
  },
)

test("a newly mounted Cloudflare frame does not inherit the keyboard retry delay", async () => {
  const page = pageFixture()
  let mounted = false
  let clicked = false
  const frame = clickableFrame(async () => {
    clicked = true
  })
  page.frames = () => (mounted && !clicked ? [frame] : [])
  page.keyboard.press = async (key?: string) => {
    if (key === "Space") mounted = true
  }
  page.title = async () => (clicked ? "Article" : "Just a moment...")
  page.content = async () => (clicked ? destination : wall)
  expect(await waitForChallengeResolution(page as unknown as Page, 2200, page.url())).toBe("ok")
  expect(clicked).toBe(true)
})

test("embedded Turnstile retries discovery without waiting three seconds for an absent frame", async () => {
  let inspections = 0
  let clicked = false
  const frame = clickableFrame(async () => {
    clicked = true
  })
  const page = {
    evaluate: async () => clicked,
    frames: () => (++inspections === 1 ? [] : [frame]),
    content: async () => "",
  }
  expect(await solveTurnstile(page as unknown as Page, 3000)).toBe(true)
  expect(clicked).toBe(true)
})

test("a failed shadow checkbox click falls through to the frame control", async () => {
  let clicked = false
  const frame = clickableFrame(async () => {
    clicked = true
  })
  const checkbox = {
    isVisible: async () => true,
    click: async () => {
      throw new Error("Checkbox detached")
    },
  }
  const checkboxHandle = { asElement: () => checkbox, dispose: async () => {} }
  const root = { evaluateHandle: async () => checkboxHandle }
  const rootHandle = { asElement: () => root, dispose: async () => {} }
  Object.assign(frame, {
    evaluateHandle: async () => ({
      getProperties: async () => new Map([["0", rootHandle]]),
      dispose: async () => {},
    }),
  })
  const page = { frames: () => [frame], content: async () => "" }
  expect(await attemptTurnstileClick(page as unknown as Page, false)).toBe(true)
  expect(clicked).toBe(true)
})

test("a known active challenge does not transfer HTML on every poll", async () => {
  const page = pageFixture()
  let clicked = false
  let activeCaptures = 0
  const frame = clickableFrame(async () => {
    clicked = true
  })
  page.frames = () => (clicked ? [] : [frame])
  page.title = async () => (clicked ? "Article" : "Just a moment...")
  page.content = async () => {
    if (!clicked) activeCaptures++
    return clicked ? destination : wall
  }
  expect(await waitForChallengeResolution(page as unknown as Page, 2000, page.url())).toBe("ok")
  expect(activeCaptures).toBe(0)
})

test("embedded click discovery does not read HTML for a disabled keyboard fallback", async () => {
  let captures = 0
  const page = {
    frames: () => [],
    content: async () => {
      captures++
      return "<html></html>"
    },
  }
  expect(await attemptTurnstileClick(page as unknown as Page, false)).toBe(false)
  expect(captures).toBe(0)
})
