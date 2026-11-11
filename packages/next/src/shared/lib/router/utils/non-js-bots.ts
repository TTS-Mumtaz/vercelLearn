// User agents of AI crawlers and agents that fetch raw HTML without executing
// JavaScript. Content that client JS would reveal (e.g. Suspense boundaries
// outlined into hidden divs) is invisible to them, so Next.js renders
// their documents without progressive loading: no outlined boundaries, no
// chunk splitting, and the complete document after all boundaries resolve.
//
// Deliberately excluded:
// - Crawlers that render JS (Googlebot, Bingbot, Applebot). Google AI
//   Overviews and Copilot grounding ride on those.
// - Agentic browsers that drive a real browser (Claude-Agent, ChatGPT Agent /
//   Operator, GoogleAgent-Mariner, Manus-User).
// - Google-Extended and Applebot-Extended: robots.txt tokens, never sent as
//   user agents.
// - The htmlLimitedBots list: those bots support JS and keep progressive
//   reveal.
export const NON_JS_BOT_UA_RE =
  /GPTBot|OAI-SearchBot|ChatGPT-User|ClaudeBot|Claude-User|Claude-SearchBot|Claude-Web|anthropic-ai|PerplexityBot|Perplexity-User|CCBot|Bytespider|Amazonbot|Amzn-User|Meta-ExternalAgent|Meta-ExternalFetcher|FacebookBot|meta-webindexer|cohere-training-data-crawler|cohere-ai|MistralAI|DeepSeekBot|MoonshotBot|KimiBot|QwenBot|TongyiBot|ERNIEBot|Google-CloudVertexBot|Gemini-Deep-Research|GoogleAgent-URLContext|Google-NotebookLM|GrokBot|xAI-Grok|YouBot|DuckAssistBot|Ai2Bot|Diffbot/i

// The config value is serialized as its String() form ("/source/flags") at
// loadConfig normalization. This returns just the source, for building route
// matchers.
export function getNonJsBotsPattern(
  nonJsBots: string | RegExp | undefined
): string {
  if (nonJsBots instanceof RegExp) {
    return nonJsBots.source
  }
  if (typeof nonJsBots === 'string') {
    const match = /^\/(.*)\/([a-z]*)$/.exec(nonJsBots)
    if (match) {
      return match[1]
    }
    return nonJsBots
  }
  return NON_JS_BOT_UA_RE.source
}
