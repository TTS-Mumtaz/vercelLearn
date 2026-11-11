import type { SpanOptions } from '@opentelemetry/api'
import type { TraceEvent, ToolingSpanSelection } from '../../../trace/types'
import { getToolingClock } from '../../../trace/clock'
import {
  LocalRecordingSpan,
  type LocalSpanDelegate,
  type LocalSpanCompletion,
} from './local-span-recorder'

const clock = getToolingClock()
let epochOffset = BigInt(clock.wallTimeMs) * BigInt(1_000_000) - clock.monotonic
export const epochTime = (time: bigint) => time + epochOffset
export const getClockOffset = () => epochOffset.toString()
export const REPLAY_EVENT_LIMIT = 1_000
const INVALID_DATA = Symbol()

export type ReportingToken = LocalSpanDelegate & {
  id: number
  parentId?: number
  generation: number
  parent?: ReportingToken
  done?: boolean
}
export type ReportingStart = {
  name: string
  parentId?: number
  start: bigint
  links?: SpanOptions['links']
}
export type ReportingCompletion = LocalSpanCompletion & { end: bigint }
export type ReplaySnapshot = {
  token: ReportingToken
  start: ReportingStart
  completion?: ReportingCompletion
  pending: boolean
}
let state: 'unregistered' | 'ready' | 'closed' = 'unregistered'
let generation = 0
let suppressed = false
let warned = false
let count = 0
let root: ReportingToken | undefined
// Only live coordinator context tokens enter this lookup; worker IDs are local
// to their batch, and completed spans leave immediately.
const coordinator = new Map<number, ReportingToken>()

export function warnLoss() {
  if (warned) return
  warned = true
  console.warn(
    'Next.js tooling OTel reporting limit reached or reporting failed; some external signals or attributes may be missing. Local trace files are unaffected.'
  )
}
export const isCurrent = (token: ReportingToken) =>
  !suppressed &&
  state !== 'closed' &&
  token.generation === generation &&
  !token.done
export const isReady = (token: ReportingToken) =>
  state === 'ready' && isCurrent(token)
export function releaseSnapshot(item: ReplaySnapshot) {
  if (!item.pending) return
  if (item.token.generation === generation && item.token !== root) count--
  item.pending = false
}
export function finish(token: ReportingToken, failed = false) {
  if (failed && token.generation === generation) warnLoss()
  token.done = true
  token.span = undefined
  token.onError = undefined
  token.parent = undefined
  if (coordinator.get(token.id) === token) coordinator.delete(token.id)
}
function clear() {
  for (const token of coordinator.values()) finish(token)
  LocalRecordingSpan.clearReporting()
  count = 0
}
export function prepare(
  delegate: LocalSpanDelegate,
  id: number,
  parentId?: number,
  parent?: ReportingToken,
  reportingRoot = false,
  local = true
): ReportingToken | undefined {
  if (suppressed) return
  if (reportingRoot && (root || state === 'closed')) {
    clear()
    generation++
    state = 'unregistered'
    warned = false
    root = undefined
  }
  if (state === 'closed') return
  const token = Object.assign(delegate, {
    id,
    parentId,
    generation,
    parent: reportingRoot
      ? undefined
      : (parent ??
        (parentId === undefined
          ? undefined
          : (coordinator.get(parentId) ?? root))),
  })
  token.onError = () => finish(token, true)
  if (reportingRoot) root = token
  if (local && coordinator.size < REPLAY_EVENT_LIMIT) coordinator.set(id, token)
  return token
}
// Inputs have the OTel data schema; methods and producer prototypes stay local.
function detach<T>(input: T): T | undefined {
  const capturedGeneration = generation
  const copy = (value: unknown, depth = 0): unknown => {
    if (typeof value === 'function' || typeof value === 'symbol')
      return undefined
    if (value === null || typeof value !== 'object') return value
    if (depth > 8) throw INVALID_DATA
    if (Array.isArray(value)) {
      const length = value.length
      if (!Number.isSafeInteger(length) || length < 0) throw INVALID_DATA
      const result: unknown[] = []
      for (let i = 0; i < length; i++) result[i] = copy(value[i], depth + 1)
      return result
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== null && prototype !== Object.prototype) return undefined
    const result: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value)) {
      const child = (value as Record<string, unknown>)[key]
      if (child === undefined || typeof child === 'function') continue
      result[key] = copy(child, depth + 1)
    }
    return result
  }
  try {
    return copy(input) as T
  } catch {
    if (generation === capturedGeneration) warnLoss()
  }
}
export function snapshot(
  token: ReportingToken,
  start: ReportingStart,
  completion?: ReportingCompletion,
  previous?: ReplaySnapshot
): ReplaySnapshot | undefined {
  if (!isCurrent(token)) return
  const payload = completion ? detach(completion) : undefined
  const terminal = completion && {
    end: completion.end,
    status:
      completion.status?.code === 2 || completion.attributes?.failed === true
        ? { code: 2 as const }
        : undefined,
  }
  if (payload) payload.status ??= terminal?.status
  if (!isCurrent(token)) return
  let item = previous?.pending ? previous : undefined
  if (!item) {
    const metadata = detach({
      ...start,
      links: token.span ? undefined : start.links,
    })
    if (!metadata) {
      finish(token)
      return
    }
    if (!isCurrent(token)) return
    if (token !== root && count >= REPLAY_EVENT_LIMIT - 1) {
      warnLoss()
      finish(token)
      return
    }
    item = { token, start: metadata, pending: true }
    if (token !== root) count++
  }
  if (completion) item.completion = payload ?? terminal
  return item
}
export function parentContext(token: ReportingToken) {
  return (
    (token.parent?.generation === generation
      ? token.parent.context
      : undefined) ??
    (token === root || (token.parentId === undefined && !token.parent)
      ? undefined
      : root?.context)
  )
}
export function configureState(
  parentId: number | undefined,
  worker: boolean,
  offset?: string
) {
  if (offset) epochOffset = BigInt(offset)
  root ??= coordinator.get(parentId!)
  suppressed = worker
  if (worker) clear()
}
export const getRoot = () => root
export function enableReporting() {
  if (state !== 'unregistered' || suppressed) return
  state = 'ready'
  LocalRecordingSpan.deliverToolingSpan()
}
export function closeReporting() {
  clear()
  state = 'closed'
  generation++
  root = undefined
}
export function replayWorkerEvents(
  events: TraceEvent[],
  selections: readonly ToolingSpanSelection[] = []
) {
  if (suppressed || state === 'closed') return
  if (!root) {
    if (events.length) warnLoss()
    return
  }
  const parents = new Map(selections.map(({ id, parentId }) => [id, parentId]))
  const batch = new Map(
    events
      .filter((event) => parents.has(event.id))
      .map((event) => [
        event.id,
        { event, token: prepare({}, event.id, undefined, root, false, false)! },
      ])
  )
  const visited = new Set<number>()
  const visiting = new Set<number>()
  for (const id of batch.keys()) {
    const stack = [id]
    while (stack.length) {
      const next = stack[stack.length - 1]
      if (visited.has(next)) {
        stack.pop()
        continue
      }
      const entry = batch.get(next)!
      const parentId = parents.get(next) ?? entry.event.parentId
      const parent = batch.get(parentId!)
      if (parent && !visited.has(parentId!)) {
        if (!visiting.has(next)) {
          visiting.add(next)
          if (!visiting.has(parentId!)) {
            stack.push(parentId!)
            continue
          }
          warnLoss()
        }
      }
      entry.token.parent =
        parent && visited.has(parentId!)
          ? parent.token
          : (coordinator.get(parentId!) ?? root)
      if (parent && !visited.has(parentId!)) entry.token.parent = root
      visited.add(next)
      visiting.delete(next)
      stack.pop()
      const { event } = entry
      LocalRecordingSpan.deliverToolingSpan(
        entry.token,
        {
          name: event.name,
          parentId: event.parentId,
          start: epochTime(BigInt(event.timestamp) * BigInt(1_000)),
        },
        {
          end: epochTime(
            (BigInt(event.timestamp) + BigInt(event.duration)) * BigInt(1_000)
          ),
          attributes: event.tags as ReportingCompletion['attributes'],
        }
      )
    }
  }
}
