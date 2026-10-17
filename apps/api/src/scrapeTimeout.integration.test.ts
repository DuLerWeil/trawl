import { expect, test } from "bun:test"
import type net from "node:net"
import { PassThrough } from "node:stream"
import type { OrchestratorDeps } from "@trawl/tiers"
import { MetricsStore } from "./metrics"
import { serveViaScrape } from "./proxy/server"
import { scrapeRoute } from "./routes/scrape"
import { v1Route } from "./routes/v1"

for (const entry of ["native", "flaresolverr", "proxy"] as const) {
  test.each([
    { mode: "deployment default", configured: 60, explicit: undefined, success: false },
    { mode: "longer explicit timeout", configured: 60, explicit: 1000, success: true },
    { mode: "shorter explicit timeout", configured: 1000, explicit: 60, success: false },
  ])(`${entry} honors $mode`, async ({ configured, explicit, success }) => {
    const origin = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(200)
        return new Response(`<html><body><article>${"Owned content. ".repeat(40)}</article></body></html>`, {
          headers: { "content-type": "text/html" },
        })
      },
    })
    const metrics = new MetricsStore()
    const stream = new PassThrough()
    const deps: OrchestratorDeps = {
      defaultMaxTimeout: configured,
      acquireBrowser: async () => {
        throw new Error("Timeout tests must not acquire a browser")
      },
      releaseBrowser() {},
      loadSession: async () => undefined,
      saveSession: async () => {},
      invalidateSession: async () => {},
    }
    try {
      let status: number
      let body: string
      if (entry === "proxy") {
        const chunks: Buffer[] = []
        stream.on("data", (chunk: Buffer) => chunks.push(chunk))
        await serveViaScrape(stream as unknown as net.Socket, origin.url.href, "GET", {}, undefined, {
          port: 0,
          host: "127.0.0.1",
          caDir: "",
          maxTier: 1,
          maxTimeout: explicit,
          deps,
        })
        body = Buffer.concat(chunks).toString()
        status = Number(body.match(/^HTTP\/1\.1 (\d+)/)?.[1])
      } else {
        const app =
          entry === "native"
            ? scrapeRoute(
                () => deps,
                () => true,
                metrics,
              )
            : v1Route({ poolReady: () => true, orchestratorDeps: () => deps, metricsStore: metrics })
        const response = await app.handle(
          new Request(`http://localhost/${entry === "native" ? "scrape" : "v1"}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cmd: "request.get", url: origin.url.href, maxTimeout: explicit }),
          }),
        )
        status = response.status
        body = await response.text()
        expect(metrics.snapshot().requests).toBe(1)
      }
      expect(status).toBe(success ? 200 : entry === "proxy" ? 502 : 500)
      expect(body).toContain(success ? "Owned content." : "Scrape deadline exceeded")
    } finally {
      origin.stop(true)
      stream.destroy()
      metrics.close()
    }
  })
}
