---
title: Session Cache
description: Automatic HTTP clearance reuse and cached browser fallback with Redis or in-memory storage.
---

# Session Cache

The shared session cache stores cookies and browser identity from successful browser requests.
It supports two reuse paths: Tier 1 can send eligible clearance over HTTP, and Tier 2 can inject
the saved cookies into a browser context. Neither path requires creating a named session.

This is a cookie cache, not a page-content cache. Each request fetches the target again. See
[Performance & Benchmarks](/getting-started/performance) for measured results and configuration.

## Automatic HTTP clearance reuse

Before an ordinary HTTP request, TRAWL checks whether the saved session can be replayed:

- The request is GET or HEAD and permits Tier 1.
- The connection is direct: no explicit request proxy or configured datacenter proxy pool.
- TLS verification is enabled.
- The entry contains the browser's User-Agent, valid Cloudflare `cf_clearance` or supported
  Anubis authentication cookies, and provenance for the exact requested origin.
- The request has no imported cookies, named `sessionId`, browser capture or content-selector wait.

Cookie domain, path, expiry and secure flags are checked before sending. Same-origin redirects
can update cookies; a cross-origin redirect returns to the browser path before credentials are
forwarded. Legacy entries without origin provenance remain usable by Tier 2.

The HTTP attempt receives at most five seconds or one third of the remaining request budget,
whichever is smaller. Rejected clearance, recognized challenge walls, detected JavaScript shells
and embedded widget markup fall back through the existing tiers. A successful replay refreshes
the cached cookies and browser identity without keeping another browser page open.

Anubis replay recognizes the default authentication cookie names, including their optional
settings suffix. Test and referrer cookies do not qualify. Custom cookie names and clearance
bound to a browser connection retain browser fallback.

## Cache driver

TRAWL supports two session cache drivers, selected at startup via `SESSION_CACHE_DRIVER`:

| Driver          | Value    | Shared across instances | External dependencies |
| --------------- | -------- | ----------------------- | --------------------- |
| Redis (default) | `redis`  | Yes                     | Redis                 |
| In-memory       | `memory` | No (per-process)        | None                  |

```ini
SESSION_CACHE_DRIVER=redis   # default, shared across instances
SESSION_CACHE_DRIVER=memory  # in-process Map, zero dependencies
```

Use `redis` when running multiple API instances behind a load balancer: sessions solved on one
instance are visible to all others. Use `memory` for single-instance deployments where the
operational overhead of Redis is not justified; sessions are scoped to the process and lost on
restart.

Both drivers support HTTP clearance reuse and browser fallback through the same `SessionCacheStore`
interface. Redis is not required for reuse in a single API process.

## Storage format

Key: `session:{hostname}` (e.g. `session:nowsecure.nl`)

Value (JSON):

```typescript
interface SessionData {
  cookies: Cookie[]
  userAgent: string
  savedAt: number     // unix timestamp ms
  httpOrigin?: string // verified direct origin eligible for HTTP reuse
}
```

TTL: `REDIS_SESSION_TTL_SECONDS` (default 3600 seconds / 1 hour) for both drivers. It controls cache
retention, not cookie validity; keeping an entry longer does not extend its cookies' expiry.

`httpOrigin` is recorded after an eligible direct GET/HEAD browser visit with verified TLS and the
same requested and final origin. Proxied or unverified visits do not grant HTTP replay provenance.

## Session key

The key is the **hostname only**, without a path, port or protocol. Pages on that hostname share a
cache entry, while cookie scope still controls which cookies are sent:

```
https://example.com/        → session:example.com
https://example.com/page    → session:example.com  (same key)
https://sub.example.com/    → session:sub.example.com  (different key)
```

Subdomains have separate entries. HTTP replay additionally requires an exact match of scheme,
hostname and port with `httpOrigin`; a shared hostname key alone never authorizes replay to another origin.

## Lifecycle

```
Request permits Tier 1
  |
  +-- eligible cached clearance --> HTTP with saved cookies and User-Agent
  |                                  accepted --> refresh cache, return
  |                                  rejected --> browser fallback
  +-- otherwise -----------------> ordinary HTTP
                                     accepted --> return
                                     blocked  --> browser fallback

Browser fallback
  |
  +-- cached state --> Tier 2: inject cookies and navigate
  |                     accepted --> refresh cache, return
  |                     failed   --> invalidate entry
  +-- no usable state --> Tier 3: fresh solve; cache returned cookies
                          failed --> Tier 4 if a proxy is configured
```

Requests with imported cookies and [named browser sessions](/api-reference/browser-sessions)
retain their separate paths and do not write their login state into this shared cache. Named
sessions keep an isolated browser context and storage; they do not use HTTP clearance replay.

Tier limits, proxy routing and the remaining request budget can stop escalation earlier.

## Invalidation

If Tier 2 navigates with cached state and still receives a recognized challenge wall, the orchestrator:

1. Calls `sessionCache.invalidate(domain)` to delete the cache entry
2. Escalates to Tier 3 to get a fresh session

A rejected HTTP replay does not immediately delete the entry: the browser may still be able
to use that clearance. Invalidation follows a failed Tier 2 attempt. This handles expiry or
rejection before the cache TTL ends.

## Redis

When `SESSION_CACHE_DRIVER=redis` (the default), TRAWL uses `new RedisClient(REDIS_URL)` from Bun's native Redis client.

The cache is optional. When `REDIS_URL` is empty or unset with the Redis driver selected, TRAWL
does not create a Redis client. Shared clearance reuse and Tier 2 are unavailable; ordinary HTTP
and fresh browser solves still work.

Each connection attempt is bounded by `REDIS_CONNECT_TIMEOUT_MS` (default 5 seconds). If Redis is
not ready, scraping continues without Tier 2 while TRAWL retries in the background every
`REDIS_RETRY_DELAY_MS` (default 5 seconds). Set the retry delay to `0` to disable reconnects after a
configured Redis endpoint becomes unavailable.

```typescript
import { RedisClient } from 'bun'

const redis = new RedisClient('redis://localhost:6379')
await redis.set('session:example.com', JSON.stringify(data), 'EX', 3600)
const raw = await redis.get('session:example.com')
```

## In-memory

When `SESSION_CACHE_DRIVER=memory`, TRAWL uses an in-process `Map` with TTL-based expiry. There is
no network I/O, so the cache is available immediately on startup. Expired entries are removed on
read and before writes. `MEMORY_SESSION_CACHE_MAX_ENTRIES` (default 1000) bounds memory growth;
when full, the least recently used session is evicted.

Because the cache lives in the API process, sessions are **not shared** across instances. A solve
on instance A is invisible to instance B, and all sessions disappear on restart. Use this driver
only for single-instance deployments. Session contents are never written to application logs.
