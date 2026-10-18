// Blocks heavy subresources in browser tiers for document-only flows, scoped to the
// main frame (the client-requested document). Anything a child frame asks for -
// challenge/captcha widgets of any provider, no origin list to maintain - loads
// untouched. Image/media/font are always safe to strip. Scripts and stylesheets are
// stripped only once the main document proves to be real content: challenge pages
// (CF interstitial, Anubis, embedded Turnstile...) bootstrap from main-frame
// scripts, so detectChallengeType vetoes blocking for that navigation. Unknowns
// always fail open - blocking is an optimization, never worth breaking a solve.
// disable() reopens everything before in-page captcha solving.

import { detectChallengeType } from "./detect"
import { currentRequestId } from "./requestScope"

interface BlockableFrame {
  parentFrame?(): unknown
}

interface BlockableRequest {
  resourceType(): string
  url?(): string
  frame?(): BlockableFrame | unknown
}

interface BlockableResponse {
  status(): number
  headers(): Record<string, string>
  request(): BlockableRequest
}

interface BlockableRoute {
  request(): BlockableRequest
  abort(errorCode?: string): Promise<void>
  fallback(): Promise<void>
}

interface BlockablePage {
  route?(pattern: string, handler: (route: BlockableRoute) => Promise<void>): Promise<unknown>
  mainFrame?(): unknown
  on?(event: "response", handler: (response: BlockableResponse) => void): void
  content?(): Promise<string>
}

const ALWAYS_BLOCKED_TYPES = new Set(["image", "media", "font"])
const CHALLENGE_GATED_TYPES = new Set(["script", "stylesheet"])
// detect.ts treats sub-3000-byte bodies carrying a challenge-platform stub as
// challenge pages, so a verdict needs the document to outgrow that threshold (or
// stop growing) before its markers are trustworthy.
const VERDICT_MIN_HTML = 3000
const VERDICT_POLL_MS = 100
const VERDICT_BUDGET_MS = 600

function isMainFrame(page: BlockablePage, request: BlockableRequest): boolean {
  if (!request.frame || !page.mainFrame) return false
  try {
    return request.frame() === page.mainFrame()
  } catch {
    return false
  }
}

// Same key=value rendering as apps/api's logger, so resource-block lines read
// like the scrape log they belong to.
function quote(value: string): string {
  return /^[A-Za-z0-9._:/-]+$/.test(value) ? value : JSON.stringify(value)
}

function describeRequest(request: BlockableRequest): { type: string; url?: string } {
  try {
    return { type: request.resourceType(), url: request.url?.() }
  } catch {
    return { type: "unknown" }
  }
}

export function installResourceBlocker(page: BlockablePage): { disable: () => void } {
  const noop = { disable: () => {} }
  // Minimal page stand-ins (unit tests, partial mocks) have no routing surface.
  if (!page.route) return noop

  // Read once here, inside the scrape's async context: Playwright route callbacks are
  // dispatched from the transport, where the request scope is no longer visible.
  const requestId = currentRequestId()

  const logDecision = (action: "allow" | "block", request: BlockableRequest, reason?: string) => {
    const { type, url } = describeRequest(request)
    const fields = ["level=debug", "scope=resource-block", `event=resource.${action}`]
    if (requestId) fields.push(`request=${requestId}`)
    fields.push(`type=${quote(type)}`)
    if (url) fields.push(`url=${quote(url)}`)
    if (reason) fields.push(`reason=${quote(reason)}`)
    console.log(fields.join(" "))
  }

  let enabled = true
  let navSeq = 0
  let docStatus: number | undefined
  let docHeaders: Record<string, string> = {}
  let verdict: Promise<boolean> | undefined // true = challenge document, let it all load

  page.on?.("response", (response) => {
    try {
      if (response.request().resourceType() === "document" && isMainFrame(page, response.request())) {
        docStatus = response.status()
        docHeaders = response.headers()
      }
    } catch {
      // fail open below
    }
  })

  const challengeDocument = (nav: number): Promise<boolean> => {
    if (verdict && nav === navSeq) return verdict
    verdict = (async () => {
      if (!page.content) return true
      let html = ""
      const deadline = Date.now() + VERDICT_BUDGET_MS
      while (Date.now() < deadline) {
        html = await page.content().catch(() => "")
        if (html.length >= VERDICT_MIN_HTML) break
        await new Promise((resolve) => setTimeout(resolve, VERDICT_POLL_MS))
      }
      return detectChallengeType(html, docHeaders, docStatus) !== "none"
    })()
    return verdict
  }

  void page.route("**/*", async (route) => {
    const request = route.request()
    const type = request.resourceType()
    if (type === "document" && isMainFrame(page, request)) {
      navSeq++
      verdict = undefined
      docStatus = undefined
      docHeaders = {}
      logDecision("allow", request, "navigation")
      await route.fallback()
      return
    }
    if (!enabled) {
      logDecision("allow", request, "blocker disabled")
      await route.fallback()
      return
    }
    if (!isMainFrame(page, request)) {
      logDecision("allow", request, "child frame")
      await route.fallback()
      return
    }
    if (ALWAYS_BLOCKED_TYPES.has(type)) {
      logDecision("block", request)
      await route.abort("blockedbyclient")
      return
    }
    if (CHALLENGE_GATED_TYPES.has(type)) {
      if (await challengeDocument(navSeq)) {
        logDecision("allow", request, "challenge document")
      } else {
        logDecision("block", request, "content page")
        await route.abort("blockedbyclient")
        return
      }
    } else {
      // fetch/xhr/other resource types are never blocked.
      logDecision("allow", request, "not blockable")
    }
    await route.fallback()
  })
  return {
    disable: () => {
      enabled = false
    },
  }
}
