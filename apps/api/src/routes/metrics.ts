import type { PoolStats } from "@trawl/types"
import { Elysia } from "elysia"
import { getPool } from "../deps"

const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

type Line = [name: string, type: "gauge" | "counter", help: string, value: number]

// Keep the series present before the pool is constructed.
const ZERO: PoolStats = {
  total: 0,
  busy: 0,
  available: 0,
  restarts: 0,
  avgRestarts: 0,
  stalled: 0,
  live: 0,
}

export function renderMetrics(stats: PoolStats): string {
  const lines: Line[] = [
    ["trawl_pool_size", "gauge", "Configured browser pool slots (BROWSER_POOL_SIZE)", stats.total],
    ["trawl_pool_busy", "gauge", "Slots currently checked out", stats.busy],
    ["trawl_pool_available", "gauge", "Slots idle, healthy and connected", stats.available],
    ["trawl_pool_live", "gauge", "Slots backed by a connected browser (idle or genuinely in flight)", stats.live],
    [
      "trawl_pool_stalled",
      "gauge",
      "Checked-out slots past their stall deadline; counted busy but dead",
      stats.stalled,
    ],
    ["trawl_pool_waiting", "gauge", "Callers blocked in acquire() waiting for a slot", stats.queueDepth ?? 0],
    [
      "trawl_pool_utilization_ratio",
      "gauge",
      "Fraction of configured slots checked out (0-1)",
      stats.total > 0 ? stats.busy / stats.total : 0,
    ],
    ["trawl_pool_acquired_total", "counter", "Slots successfully acquired since start", stats.acquired ?? 0],
    [
      "trawl_pool_exhausted_total",
      "counter",
      "acquire() calls that timed out waiting for a slot since start",
      stats.exhausted ?? 0,
    ],
    [
      "trawl_pool_acquire_wait_seconds_total",
      "counter",
      "Cumulative seconds spent waiting for granted browser checkouts",
      (stats.acquireWaitMsTotal ?? 0) / 1000,
    ],
    ["trawl_browser_restarts_total", "counter", "Browser restarts across all pool entries since start", stats.restarts],
  ]

  return `${lines
    .map(([name, type, help, value]) => `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}`)
    .join("\n")}\n`
}

export function metricsRoute(getStats = (): PoolStats | undefined => getPool()?.getStats()) {
  return new Elysia().get("/metrics", ({ set }) => {
    set.headers["content-type"] = CONTENT_TYPE
    return renderMetrics(getStats() ?? ZERO)
  })
}
