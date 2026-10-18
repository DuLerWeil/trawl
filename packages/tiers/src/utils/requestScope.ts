import { AsyncLocalStorage } from "node:async_hooks"

// Correlates everything a scrape spawns (browser tiers, route handlers, solvers) with
// the request id the API already logs. AsyncLocalStorage keeps concurrent scrapes
// apart, so the id never needs to travel through every intermediate option object.
const storage = new AsyncLocalStorage<string>()

export function withRequestId<T>(requestId: string, fn: () => T): T {
  return storage.run(requestId, fn)
}

export function currentRequestId(): string | undefined {
  return storage.getStore()
}
