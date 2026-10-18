import type { Cookie, SessionData } from "@trawl/types"

function matches(cookie: Cookie, url: URL): boolean {
  const domain = cookie.domain.toLowerCase()
  const host = domain.startsWith(".") ? domain.slice(1) : domain
  return (
    (url.hostname === host || (domain.startsWith(".") && url.hostname.endsWith(`.${host}`))) &&
    (!cookie.secure || url.protocol === "https:") &&
    (cookie.expires === -1 || cookie.expires > Date.now() / 1000) &&
    (url.pathname === cookie.path ||
      (url.pathname.startsWith(cookie.path) && (cookie.path.endsWith("/") || url.pathname[cookie.path.length] === "/")))
  )
}

// A request-local jar for a browser-verified origin. Cross-origin redirects and
// cookie attributes we cannot preserve return to the browser instead.
export class HttpSessionCookies {
  private cookies: Cookie[]
  private readonly domains: Set<string>

  constructor(
    private readonly origin: string,
    cookies: Cookie[],
  ) {
    this.cookies = cookies.map((cookie) => ({ ...cookie }))
    this.domains = new Set(cookies.map((cookie) => cookie.domain.replace(/^\./, "").toLowerCase()))
  }

  static from(session: SessionData | undefined, url: string): HttpSessionCookies | undefined {
    const target = new URL(url)
    // Replay is bound to the origin the browser verified, so ordinary (non-challenge)
    // sessions replay too - the site may gate content on login cookies alone.
    if (session?.httpOrigin !== target.origin || !session.userAgent || session.cookies.length > 200) return
    return new HttpSessionCookies(target.origin, session.cookies)
  }

  header(url: string): string {
    const target = new URL(url)
    if (target.origin !== this.origin) throw new Error("session-redirect-needs-browser")
    const header = this.cookies
      .filter((cookie) => matches(cookie, target))
      .sort((a, b) => b.path.length - a.path.length)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject header injection in cached values
    if (header.length > 16_384 || /[\r\n\x00]/.test(header)) throw new Error("session-cookies-need-browser")
    return header
  }

  update(headers: Headers, url: string): void {
    const target = new URL(url)
    for (const raw of headers.getSetCookie()) {
      try {
        if (raw.length > 4096) throw new Error()
        const parsed = Bun.Cookie.parse(raw)
        if (parsed.partitioned) throw new Error()
        const domain = parsed.domain?.replace(/^\./, "").toLowerCase() ?? target.hostname
        if (target.hostname !== domain && !target.hostname.endsWith(`.${domain}`)) continue
        // Parent domains are accepted only if the browser already validated them.
        if (domain !== target.hostname && !this.domains.has(domain)) throw new Error()
        const path = /;\s*path=\//i.test(raw)
          ? parsed.path
          : target.pathname.slice(0, target.pathname.lastIndexOf("/")) || "/"
        if (parsed.secure && target.protocol !== "https:") continue
        if (parsed.sameSite === "none" && !parsed.secure) continue
        if (parsed.name.startsWith("__Secure-") && !parsed.secure) continue
        if (parsed.name.startsWith("__Host-") && (!parsed.secure || parsed.domain || path !== "/")) continue
        const cookie: Cookie = {
          name: parsed.name,
          value: parsed.value,
          domain: parsed.domain ? `.${domain}` : domain,
          path,
          expires:
            parsed.maxAge !== undefined
              ? Math.max(0, Date.now() / 1000 + parsed.maxAge)
              : parsed.expires
                ? parsed.expires.getTime() / 1000
                : -1,
          httpOnly: parsed.httpOnly,
          secure: parsed.secure,
          sameSite: parsed.sameSite === "strict" ? "Strict" : parsed.sameSite === "none" ? "None" : "Lax",
        }
        this.cookies = this.cookies.filter(
          (old) =>
            old.name !== cookie.name ||
            old.domain.replace(/^\./, "").toLowerCase() !== domain ||
            old.path !== cookie.path,
        )
        if (cookie.expires === -1 || cookie.expires > Date.now() / 1000) this.cookies.push(cookie)
        if (this.cookies.length > 200) throw new Error()
      } catch {
        throw new Error("session-cookies-need-browser")
      }
    }
  }

  snapshot(): Cookie[] {
    return this.cookies.filter((cookie) => cookie.expires === -1 || cookie.expires > Date.now() / 1000)
  }
}
