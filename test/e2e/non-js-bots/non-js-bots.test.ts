import { nextTestSetup } from 'e2e-utils'

const CLAUDE_BOT_UA =
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)'
const GPT_BOT_UA =
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)'
const GOOGLEBOT_UA =
  'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
const TWITTERBOT_UA = 'Twitterbot/1.0'

// React SSR outlines large completed Suspense boundaries into a hidden div
// plus a script that reveals them with JS. Non-JS crawlers must not receive
// either.
const HIDDEN_OUTLINE_RE = /<div hidden id="S:/

describe('non-js-bots', () => {
  const { next } = nextTestSetup({
    files: __dirname,
  })

  async function fetchHTML(route: string, userAgent?: string) {
    const res = await next.fetch(route, {
      headers: userAgent ? { 'user-agent': userAgent } : undefined,
    })
    return { res, html: await res.text() }
  }

  describe.each([
    ['/large-boundary', 'app'],
    ['/ssr-large', 'pages'],
  ])('%s', (route, marker) => {
    it('sends no hidden content to non-JS bots', async () => {
      for (const userAgent of [CLAUDE_BOT_UA, GPT_BOT_UA]) {
        const { html } = await fetchHTML(route, userAgent)
        expect(html).not.toMatch(HIDDEN_OUTLINE_RE)
        expect(html).not.toContain('$RC(')
        expect(html).toContain(`marker-${marker}-start`)
        expect(html).toContain(`marker-${marker}-end`)
      }
    })

    it('outlines large boundaries for regular browsers', async () => {
      const { html } = await fetchHTML(route)
      expect(html).toMatch(HIDDEN_OUTLINE_RE)
      expect(html).toContain('$RC(')
      expect(html).toContain(`marker-${marker}-start`)
    })

    it('outlines large boundaries for JS-capable bots', async () => {
      // Googlebot renders JS. HTML-limited bots like Twitterbot support JS as
      // well, so they keep the progressive reveal.
      for (const userAgent of [GOOGLEBOT_UA, TWITTERBOT_UA]) {
        const { html } = await fetchHTML(route, userAgent)
        expect(html).toMatch(HIDDEN_OUTLINE_RE)
        expect(html).toContain('$RC(')
      }
    })
  })

  describe('prerendered routes', () => {
    it('shows large boundaries to non-JS bots (app)', async () => {
      // The prerendered artifact has progressively chunked boundaries, so the
      // request must bypass it and render dynamically. A browser with JS
      // disabled perceives visibility like a crawler: innerText excludes
      // content that only JS would reveal.
      const browser = await next.browser('/static-large-boundary', {
        userAgent: CLAUDE_BOT_UA,
        disableJavaScript: true,
        waitUntil: 'load',
      })
      const text = await browser.elementByCss('body').text()
      expect(text).toContain('marker-app-start')
      expect(text).toContain('marker-app-end')
      // The dynamically rendered response must not be shared-cacheable.
      const { res } = await fetchHTML('/static-large-boundary', CLAUDE_BOT_UA)
      expect(res.headers.get('cache-control') ?? '').not.toContain('s-maxage')
    })

    it('serves the progressively chunked document to regular browsers (app)', async () => {
      const { html } = await fetchHTML('/static-large-boundary')
      expect(html).toMatch(HIDDEN_OUTLINE_RE)
      expect(html).toContain('$RC(')
    })

    it('shows large boundaries to non-JS bots (pages)', async () => {
      const browser = await next.browser('/static-large', {
        userAgent: CLAUDE_BOT_UA,
        disableJavaScript: true,
        waitUntil: 'load',
      })
      const text = await browser.elementByCss('body').text()
      expect(text).toContain('marker-pages-start')
      expect(text).toContain('marker-pages-end')
    })

    it('serves the progressively chunked document to regular browsers (pages)', async () => {
      const { html } = await fetchHTML('/static-large')
      expect(html).toMatch(HIDDEN_OUTLINE_RE)
      expect(html).toContain('$RC(')
    })
  })

  describe('/slow-boundary', () => {
    it('waits for pending boundaries for non-JS bots', async () => {
      const { html } = await fetchHTML('/slow-boundary', CLAUDE_BOT_UA)
      // Match the SSR'd elements: the markers also appear in the RSC payload
      // (serialized as JSON strings) regardless of streaming behavior.
      expect(html).toContain('<p>slow-content-marker</p>')
      expect(html).not.toContain('<p>slow-fallback-marker</p>')
    })

    it('streams pending boundaries for regular browsers', async () => {
      const { html } = await fetchHTML('/slow-boundary')
      expect(html).toContain('<p>slow-fallback-marker</p>')
      expect(html).toContain('$RC(')
    })
  })
})
