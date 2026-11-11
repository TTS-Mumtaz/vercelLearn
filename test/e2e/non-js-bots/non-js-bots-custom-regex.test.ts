import { nextTestSetup } from 'e2e-utils'

const CLAUDE_BOT_UA =
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)'
const MINIBOT_UA = 'Minibot/1.0'

const HIDDEN_OUTLINE_RE = /<div hidden id="S:/

describe('non-js-bots custom regex', () => {
  const { next } = nextTestSetup({
    files: __dirname,
    overrideFiles: {
      'next.config.js': `
        module.exports = {
          nonJsBots: /Minibot/i,
        }
      `,
    },
  })

  it('sends no hidden content to bots matching the custom regex', async () => {
    const res = await next.fetch('/large-boundary', {
      headers: { 'user-agent': MINIBOT_UA },
    })
    const html = await res.text()
    expect(html).not.toMatch(HIDDEN_OUTLINE_RE)
    expect(html).not.toContain('$RC(')
    expect(html).toContain('marker-app-start')
  })

  it('replaces the default regex', async () => {
    // ClaudeBot is in the default list, but the custom regex replaces it.
    const res = await next.fetch('/large-boundary', {
      headers: { 'user-agent': CLAUDE_BOT_UA },
    })
    const html = await res.text()
    expect(html).toMatch(HIDDEN_OUTLINE_RE)
    expect(html).toContain('$RC(')
  })
})
