import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { installResourceBlocker } from "../src/utils/resourceBlocker"

interface FakeRoute {
  request(): { resourceType(): string; url(): string; frame(): unknown }
  abort(errorCode?: string): Promise<void>
  fallback(): Promise<void>
}

function setup() {
  const mainFrame = {}
  let handler: ((route: FakeRoute) => Promise<void>) | undefined
  const page = {
    route: async (_pattern: string, routeHandler: (route: FakeRoute) => Promise<void>) => {
      handler = routeHandler
    },
    mainFrame: () => mainFrame,
    on: () => {},
  }
  const decisions: string[] = []
  const dispatch = async (type: string) => {
    const request = {
      resourceType: () => type,
      url: () => "https://example.com/a.png",
      frame: () => mainFrame,
    }
    await handler?.({
      request: () => request,
      abort: async () => {
        decisions.push(`block:${type}`)
      },
      fallback: async () => {
        decisions.push(`allow:${type}`)
      },
    })
  }
  installResourceBlocker(page)
  return { dispatch, decisions }
}

describe("installResourceBlocker logging", () => {
  const previousLevel = process.env.LOG_LEVEL
  const originalLog = console.log
  let logs: string[] = []

  beforeEach(() => {
    logs = []
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    }
  })

  afterEach(() => {
    console.log = originalLog
    if (previousLevel === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = previousLevel
  })

  it("keeps debug decisions quiet at info level", async () => {
    process.env.LOG_LEVEL = "info"
    const { dispatch, decisions } = setup()

    await dispatch("image")

    expect(decisions).toEqual(["block:image"])
    expect(logs).toEqual([])
  })

  it("logs decisions when LOG_LEVEL=debug", async () => {
    process.env.LOG_LEVEL = "debug"
    const { dispatch } = setup()

    await dispatch("image")

    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("level=debug scope=resource-block event=resource.block")
  })
})
