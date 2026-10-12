import { fetchText } from './types.ts'

const SHELL_ATTEMPTS = 3

/**
 * A docs.byteplus.com page as rendered HTML. Some fetches get the doc
 * center's client-render shell instead: no `window._ROUTER_DATA`, the SSR
 * slots left as `<!--<?- html ?>-->`. A refetch usually gets the rendered
 * page, so the shell is retried; a page that is still the shell after the
 * last attempt throws. HTTP errors are not retried.
 */
export async function fetchByteplusDoc(url: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const html = await fetchText(url)
    if (html.includes('window._ROUTER_DATA')) return html
    if (attempt === SHELL_ATTEMPTS) {
      throw new Error(
        `${url}: served the unrendered page shell ${String(SHELL_ATTEMPTS)} times`,
      )
    }
  }
}
