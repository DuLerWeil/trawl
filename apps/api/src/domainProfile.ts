// Per-domain learned behavior for the scrape pipeline: after repeated Tier 1 needs-js
// outcomes on a host, plain HTTP is skipped on later requests. Purely advisory: entries
// expire on their own and a stale hint can only cost one browser run, never correctness.

import type { ScrapeRequest, TierResult } from "@trawl/types"

const TTL_MS = 30 * 60 * 1000
const MAX_ENTRIES = 1_000
// Skip Tier 1 only after this many consecutive needs-js outcomes - one stale wall is
// not a pattern, two in a row means the plain fetch keeps losing here.
const TIER1_SKIP_STREAK = 2

interface Entry {
  lastSeen: number
  tier1NeedsJsStreak: number
}

const entries = new Map<string, Entry>()

function touch(domain: string): Entry | undefined {
  const entry = entries.get(domain)
  if (!entry) return
  if (Date.now() - entry.lastSeen > TTL_MS) {
    entries.delete(domain)
    return
  }
  return entry
}

function entryFor(domain: string): Entry {
  const existing = touch(domain)
  if (existing) {
    existing.lastSeen = Date.now()
    return existing
  }
  while (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
  const fresh: Entry = { lastSeen: Date.now(), tier1NeedsJsStreak: 0 }
  entries.set(domain, fresh)
  return fresh
}

/** Apply the learned hint for `domain` to an outgoing request. */
export function applyDomainProfile(req: ScrapeRequest, domain: string | undefined): ScrapeRequest {
  const entry = domain ? touch(domain) : undefined
  if (!entry || entry.tier1NeedsJsStreak < TIER1_SKIP_STREAK) return req
  return { ...req, skipHttp: true }
}

/** Fold a completed scrape into the learned profile for `domain`. */
export function refreshDomainProfile(
  domain: string | undefined,
  timings: TierResult[],
  opts: { resultTier?: number; failure?: boolean; sessionCached?: boolean },
): void {
  if (!domain) return
  const tier1 = timings.find((t) => t.tier === 1)
  if (tier1?.status === "needs-js") {
    entryFor(domain).tier1NeedsJsStreak++
  } else if (!opts.failure && tier1?.status === "success") {
    entryFor(domain).tier1NeedsJsStreak = 0
  }
  // A fresh browser solve mints a new clearance - exactly what the next Tier 1 replay
  // needs - so it clears the streak.
  if (!opts.failure && (opts.resultTier ?? 0) >= 2 && !opts.sessionCached) {
    entryFor(domain).tier1NeedsJsStreak = 0
  }
}
