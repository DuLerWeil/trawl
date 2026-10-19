export type OutboundUrlValidator = (url: string) => Promise<void>

interface BrowserRoute {
  abort(errorCode?: string): Promise<void>
  fallback(): Promise<void>
  request(): { url(): string }
}

interface RoutablePage {
  route(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<unknown>
  unroute(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<unknown>
}

export async function installOutboundPolicy(
  page: RoutablePage,
  validate?: OutboundUrlValidator,
): Promise<(() => Promise<unknown>) | undefined> {
  if (!validate) return undefined
  const enforce = async (route: BrowserRoute) => {
    try {
      await validate(route.request().url())
      await route.fallback()
    } catch {
      await route.abort("blockedbyclient")
    }
  }
  await page.route("**/*", enforce)
  // Pages retained by a session outlive one request; the caller unrouts what it installed.
  return () => page.unroute("**/*", enforce)
}
