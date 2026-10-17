# Automatic HTTP clearance reuse

Browser-verified Cloudflare clearance is replayed with the same User-Agent over HTTP on direct GET/HEAD requests. Rejected clearance, detected widgets and empty JavaScript shells return to the browser. Cookies are scoped per origin, domain, path, expiry and secure transport; responses and same-origin redirects can rotate or delete them. No extra browser tabs are retained.

[Sanitized measurements](../apps/web/public/benchmarks/2026-10-17-http-clearance.json)

Runtime sources: 68b1701 before HTTP replay, fc1aa5f with HTTP replay.

## Default request comparison

Two rounds, three requests per target, Redis cleared before each target. Same ARM64 host, one warm browser, economy settings, 30-second request budget, no memory cap or CPU quota and 1 GiB shared memory. Each successful response passed expected-content, destination and challenge-wall checks. The earlier complete baseline is preserved; a fresh three-target baseline confirmation is reported separately.

| Target | Verified before / after | First median before / after | Repeat median before / after |
| --- | ---: | ---: | ---: |
| cloudflare-demo | 6/6 / 6/6 | 7,025 ms / 6,368 ms | 2,319 ms / 1,093 ms |
| 1337x | 6/6 / 6/6 | 5,248 ms / 4,770 ms | 1,110 ms / 114 ms |
| mvnrepository | 6/6 / 6/6 | 3,882 ms / 4,152 ms | 1,870 ms / 228 ms |
| fragrantica | 6/6 / 6/6 | 5,638 ms / 2,730 ms | 1,466 ms / 3,394 ms |
| discogs-search | 0/6 / 0/6 | Unverified / Unverified | Unverified / Unverified |
| eztv | 6/6 / 6/6 | 5,484 ms / 3,986 ms | 2,717 ms / 578 ms |

Fragrantica's two slow repeats took 8,862 and 6,251 ms. Runtime traces show a cookie-free
HTTP probe followed by a fresh Tier 3 solve: the preceding request succeeded over ordinary
HTTP and had not created a browser clearance cache. Those requests did not enter the new
HTTP replay path. They remain in the comparison; the faster path does not prevent a site
from issuing a new challenge when no verified clearance is available.

## Resources across the complete default workload

Failed requests remain in these totals. Memory values include Redis; process/thread/descriptor/PID peaks refer to the application container.

| Metric | Before | After |
| --- | ---: | ---: |
| Verified responses | 30/36 | 30/36 |
| CPU time, all requests | 122.72 s | 92.41 s |
| CPU time, repeat requests | 60.49 s | 46.19 s |
| Peak working memory | 1391 MiB | 1116 MiB |
| Peak total memory | 1588 MiB | 1282 MiB |
| Peak anonymous memory | 1045 MiB | 1016 MiB |
| Peak processes | 14 | 11 |
| Peak threads | 330 | 346 |
| Peak descriptors | 555 | 413 |
| Peak cgroup PIDs | 330 | 349 |
| OOM kills | 0 | 0 |

Thread and PID peaks were slightly higher in this run. The change avoids browser work on
accepted HTTP replays; it does not change Firefox's worker/process limits or guarantee that
every resource maximum falls across live-site samples.

## Fresh baseline confirmation

Same baseline image and first three targets, one additional round. These observations are separate from the full baseline above.

| Target | Baseline repeat median | Final-build repeat median |
| --- | ---: | ---: |
| cloudflare-demo | 2,372 ms | 1,093 ms |
| 1337x | 1,243 ms | 114 ms |
| mvnrepository | 1,846 ms | 228 ms |

## Verification and limits

- `bun run verify`: formatting/lint, workspace typechecks, 1,094 passing tests (85 opt-in integration tests skipped) and production builds.
- Owned Docker/Camoufox fixture verifies native and `/v1` HTTP clearance reuse, correct cookies/User-Agent, browser screenshots and actual embedded-widget token verification.
- Existing browser-session integration tests verify login/storage persistence and isolation, including `/v1` compatibility.
- The separate Docker checks passed the focused native/`/v1`/widget integration test and all six browser-session integration tests.
- Regression tests cover expiry, cookie rotation/deletion, redirect scope, proxy exclusion, browser-only requests, TLS verification, rejected clearance, application shells and bounded HTTP fallback.
- The built image matches all 100 runtime source files. No dependency or deployment resource settings changed for this feature.
- Existing live TRAWL and Prowlarr containers were unchanged.

The comparison measures whole requests, not an isolated CAPTCHA-solving rate. Six Discogs timeouts remain in each full cohort. First visits still require normal solving; the improvement is reuse after a successful browser visit. Small samples cannot establish a universal speedup or absence of OOM on arbitrary sites. Browser-rendered application state still requires browser options such as `skipHttp: true`.

## Reproduce

Use native ARM64 Docker images. Pull `redis:8` and the pinned FlareSolverr and Byparr
references at the top of [run.py](run.py) first; the runner inspects all three tool images
even when only TRAWL requests are selected.

```bash
docker build -f apps/api/Dockerfile -t trawl:http-clearance .
python3 benchmarks/run.py --trawl-image trawl:http-clearance --rounds 2 --products trawl --session-products --timeout-ms 30000 --output /tmp/trawl-http-clearance-new
```
