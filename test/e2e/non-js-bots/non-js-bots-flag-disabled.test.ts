import { nextTestSetup } from 'e2e-utils'

const CLAUDE_BOT_UA =
  'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)'

const HIDDEN_OUTLINE_RE = /<div hidden id="S:/

describe('non-js-bots flag disabled', () => {
  const { next } = nextTestSetup({
    files: __dirname,
    overrideFiles: {
      // Explicit false so the Cache Components shard default cannot enable it.
      'next.config.js': `
        module.exports = {
          experimental: {
            disableProgressiveLoadingForNonJsBots: false,
          },
        }
      `,
    },
  })

  it('keeps progressive loading for non-JS bots when the flag is off', async () => {
    const res = await next.fetch('/large-boundary', {
      headers: { 'user-agent': CLAUDE_BOT_UA },
    })
    const html = await res.text()
    expect(html).toMatch(HIDDEN_OUTLINE_RE)
    expect(html).toContain('$RC(')
  })
})
