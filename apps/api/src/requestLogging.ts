import { PoolExhaustedError } from "@trawl/browser"
import { type OrchestratorDeps, ScrapeError, scrape, withRequestId } from "@trawl/tiers"
import type { ScrapeRequest, ScrapeResult, TierResult } from "@trawl/types"
import { applyDomainProfile, refreshDomainProfile } from "./domainProfile"
import { log, requestId, safeMessage, safeUrl } from "./logger"
import { type MetricsStore, metrics } from "./metrics"

export type ScrapeSource = "native" | "flaresolverr" | "mcp" | "proxy"

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

export async function runLoggedScrape(
  source: ScrapeSource,
  req: ScrapeRequest,
  deps: OrchestratorDeps,
  runScrape: typeof scrape = scrape,
  id = requestId(),
  metricsStore: MetricsStore = metrics,
): Promise<ScrapeResult> {
  const started = Date.now()
  const domain = hostnameOf(req.url)
  // Apply the learned per-domain profile: skip stages that keep losing for this host.
  req = applyDomainProfile(req, domain)

  log("info", "scrape", {
    event: "request.start",
    request: id,
    source,
    method: req.method ?? "GET",
    target: safeUrl(req.url),
    timeoutMs: req.maxTimeout ?? deps.defaultMaxTimeout ?? 60_000,
    maxTier: req.maxTier ?? 4,
    proxy: Boolean(req.proxy),
  })

  const originalAttempt = deps.onTierAttempt
  const tracedDeps: OrchestratorDeps = {
    ...deps,
    onTierAttempt: (attempt: TierResult) => {
      originalAttempt?.(attempt)
      log("info", "scrape", {
        event: "tier.complete",
        request: id,
        tier: attempt.tier,
        status: attempt.status,
        durationMs: attempt.durationMs,
        reason: attempt.reason ? safeMessage(attempt.reason) : undefined,
      })
    },
  }

  try {
    const result = await withRequestId(id, () => runScrape(req, tracedDeps))
    metricsStore.record({
      source,
      url: req.url,
      durationMs: Date.now() - started,
      tier: result.tier,
      attempts: result.timings,
      statusCode: result.statusCode,
    })
    log("info", "scrape", {
      event: "request.success",
      request: id,
      source,
      statusCode: result.statusCode,
      tier: result.tier,
      totalMs: result.totalMs,
      bytes: result.body?.byteLength ?? result.html.length,
      cookies: result.cookies.length,
      sessionCached: result.sessionCached,
      proxyUsed: result.proxyUsed,
      captchas: result.captchasSolved?.join(","),
    })
    refreshDomainProfile(domain, result.timings, {
      resultTier: result.tier,
      sessionCached: result.sessionCached,
    })
    return result
  } catch (error) {
    const last = error instanceof ScrapeError ? error.timings.at(-1) : undefined
    if (error instanceof ScrapeError) refreshDomainProfile(domain, error.timings, { failure: true })
    metricsStore.record({ source, url: req.url, durationMs: Date.now() - started, error })
    log(error instanceof PoolExhaustedError ? "warn" : "error", "scrape", {
      event: "request.failure",
      request: id,
      source,
      totalMs: Date.now() - started,
      tier: last?.tier,
      status: last?.status,
      reason: safeMessage(error instanceof Error ? error.message : String(error)),
    })
    throw error
  }
}
