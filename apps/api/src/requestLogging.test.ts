import { describe, expect, spyOn, test } from "bun:test"
import type { OrchestratorDeps } from "@trawl/tiers"
import type { ScrapeRequest, ScrapeResult, TierResult } from "@trawl/types"
import { MetricsStore } from "./metrics"
import { runLoggedScrape } from "./requestLogging"

const deps = (): OrchestratorDeps => ({
  acquireBrowser: async () => {
    throw new Error("unused")
  },
  releaseBrowser: () => {},
  loadSession: async () => undefined,
  saveSession: async () => {},
  invalidateSession: async () => {},
})

describe("request logging", () => {
  test("records scraper results without changing their response", async () => {
    const store = new MetricsStore()
    const result: ScrapeResult = {
      url: "https://example.com/final",
      html: "ok",
      cookies: [],
      userAgent: "test",
      statusCode: 200,
      tier: 1,
      sessionCached: false,
      timings: [{ tier: 1, status: "success", durationMs: 2 }],
      totalMs: 3,
    }
    const output = spyOn(console, "log").mockImplementation(() => {})
    try {
      expect(
        await runLoggedScrape(
          "native",
          { url: "https://example.com/private?token=1" },
          deps(),
          async () => result,
          "test",
          store,
        ),
      ).toBe(result)
    } finally {
      output.mockRestore()
    }
    expect(store.snapshot().requests).toBe(1)
    expect(store.snapshot().byTier[1]).toEqual({ attempts: 1, successes: 1 })
    expect(JSON.stringify(store.snapshot())).not.toContain("private")
  })

  test("logs a redacted start, each tier, and a success summary", async () => {
    const lines: string[] = []
    const output = spyOn(console, "log").mockImplementation((line) => lines.push(String(line)))
    const result: ScrapeResult = {
      url: "https://example.com/",
      html: "ok",
      cookies: [],
      userAgent: "test",
      statusCode: 200,
      tier: 1,
      sessionCached: false,
      timings: [{ tier: 1, status: "success", durationMs: 2 }],
      totalMs: 3,
    }
    const attempt = result.timings[0]
    if (!attempt) throw new Error("missing test timing")
    try {
      await runLoggedScrape(
        "native",
        { url: "https://user:secret@example.com/page?token=secret" },
        { ...deps(), defaultMaxTimeout: 120000 },
        async (_request, tracedDeps) => {
          tracedDeps.onTierAttempt?.(attempt)
          return result
        },
        "abc123",
      )
    } finally {
      output.mockRestore()
    }

    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain("event=request.start request=abc123 source=native")
    expect(lines[0]).toContain("target=https://example.com/page")
    expect(lines[0]).toContain("timeoutMs=120000")
    expect(lines.join("\n")).not.toContain("secret")
    expect(lines[1]).toContain("event=tier.complete request=abc123 tier=1 status=success")
    expect(lines[2]).toContain("event=request.success request=abc123")
  })

  test("a fresh browser solve resets the Tier 1 needs-js streak for the next HTTP replay", async () => {
    const target = "https://learn-cache-regression.test/page"
    const seen: ScrapeRequest[] = []
    const timings = (): TierResult[] => [
      { tier: 1, status: "needs-js", durationMs: 5 },
      { tier: 2, status: "success", durationMs: 10 },
    ]
    const result = (sessionCached: boolean): ScrapeResult => ({
      url: target,
      html: "ok",
      cookies: [],
      userAgent: "test",
      statusCode: 200,
      tier: 2,
      sessionCached,
      timings: timings(),
      totalMs: 15,
    })
    const run = (outcome: ScrapeResult) =>
      runLoggedScrape(
        "native",
        { url: target },
        deps(),
        async (request) => {
          seen.push(request)
          return outcome
        },
        "learn",
        new MetricsStore(),
      )

    const output = spyOn(console, "log").mockImplementation(() => {})
    try {
      // A cold session with a successful browser solve earned a fresh clearance, so the
      // next request must try Tier 1 again instead of skipping it.
      await run(result(false))
      await run(result(true))
      await run(result(true))
      await run(result(true))
    } finally {
      output.mockRestore()
    }

    expect(seen).toHaveLength(4)
    expect(seen[0]?.skipHttp).toBeFalsy()
    // A cached-session success does not reset the streak...
    expect(seen[1]?.skipHttp).toBeFalsy()
    expect(seen[2]?.skipHttp).toBeFalsy()
    // ...so two consecutive needs-js outcomes skip Tier 1 again.
    expect(seen[3]?.skipHttp).toBe(true)
  })
})
