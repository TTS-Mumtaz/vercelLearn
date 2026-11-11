import {
  HTML_LIMITED_BOT_UA_RE_STRING,
  isOversizedUserAgent,
} from '../../shared/lib/router/utils/is-bot'
import { NON_JS_BOT_UA_RE } from '../../shared/lib/router/utils/non-js-bots'

let cachedPattern: string | undefined
let cachedRegex: RegExp | undefined

export function shouldServeStreamingMetadata(
  userAgent: string,
  htmlLimitedBots: string | undefined
): boolean {
  // No real UA string exceeds this bound, so oversized UAs are not bots we need
  // to identify; skip the (possibly user-configured) regex on them entirely.
  if (!userAgent || isOversizedUserAgent(userAgent)) {
    return true
  }
  const pattern = htmlLimitedBots || HTML_LIMITED_BOT_UA_RE_STRING
  if (cachedPattern !== pattern) {
    cachedPattern = pattern
    cachedRegex = new RegExp(pattern, 'i')
  }
  // Only block metadata for HTML-limited bots
  if (cachedRegex!.test(userAgent)) {
    return false
  }
  return true
}

let cachedNonJsBotsPattern: string | undefined
let cachedNonJsBotsRegex: RegExp | undefined

// Regex configs cross JSON manifests as a string (the same pattern as
// htmlLimitedBots, images.remotePatterns, and the routes manifest). The
// `/source/flags` form keeps the flags, unlike `.source`.
function getNonJsBotsRegex(nonJsBots: string | RegExp | undefined): RegExp {
  const pattern =
    nonJsBots instanceof RegExp
      ? String(nonJsBots)
      : (nonJsBots ?? String(NON_JS_BOT_UA_RE))
  if (cachedNonJsBotsPattern !== pattern) {
    cachedNonJsBotsPattern = pattern
    const match = /^\/(.*)\/([a-z]*)$/.exec(pattern)
    cachedNonJsBotsRegex = match
      ? new RegExp(match[1], match[2])
      : new RegExp(pattern)
  }
  return cachedNonJsBotsRegex!
}

export function shouldDisableProgressiveLoading(
  userAgent: string | null | undefined,
  nonJsBots: RegExp | string | undefined
): boolean {
  // No real UA string exceeds this bound, so oversized UAs are not bots we need
  // to identify; skip the (possibly user-configured) regex on them entirely.
  if (!userAgent || isOversizedUserAgent(userAgent)) {
    return false
  }
  return getNonJsBotsRegex(nonJsBots).test(userAgent)
}
