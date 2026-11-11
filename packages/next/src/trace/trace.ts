import { reporter } from './report'
import type {
  SpanId,
  TraceEvent,
  TraceState,
  ToolingSpanSelection,
} from './types'
import type {
  AttributeValue,
  Span as OpenTelemetrySpan,
} from '@opentelemetry/api'
import { getTimestamp } from '../server/lib/trace/utils'
import { getToolingClock } from './clock'

export { toHrTime as toolingSpanTime } from '../server/lib/trace/utils'
export { getToolingClock }

let replay:
  | typeof import('../server/lib/trace/local-span-replay.node')
  | undefined

if (process.env.NEXT_RUNTIME === 'edge') {
  replay = undefined
} else {
  replay =
    require('../server/lib/trace/local-span-replay.node') as typeof import('../server/lib/trace/local-span-replay.node')
}

const NUM_OF_MICROSEC_IN_NANOSEC = BigInt('1000')
const NUM_OF_SEC_IN_NANOSEC = BigInt('1000000000')
const NUM_OF_MILLISEC_IN_NANOSEC = BigInt('1000000')

let count = 0
const getId = () => {
  count++
  return count
}
let defaultParentSpanId: SpanId | undefined
let shouldSaveTraceEvents: boolean | undefined
let savedTraceEvents: TraceEvent[] = []
let savedToolingSpanSelections: ToolingSpanSelection[] = []

const RECORD_SPAN_THRESHOLD_MS = parseInt(
  process.env.NEXT_TRACE_SPAN_THRESHOLD_MS ?? '-1'
)

interface Attributes {
  [key: string]: unknown
}

/** Adapt tooling payloads to the existing local recorder's attribute types. */
export function normalizeToolingAttributes(
  attributes: Attributes | undefined
): Record<string, AttributeValue> {
  const entries: [string, AttributeValue][] = []
  for (const key of Object.keys(attributes ?? {})) {
    try {
      const value = attributes![key]
      if (value === null || value === undefined) continue
      if (isToolingAttributeValue(value)) {
        entries.push([key, value])
      } else {
        const encoded = JSON.stringify(value)
        if (encoded !== undefined) entries.push([key, encoded])
      }
    } catch {
      // Diagnostics must not interrupt the work being measured. Cyclic values,
      // bigint payloads and throwing serializers cannot become OTel attributes.
    }
  }
  return Object.fromEntries(entries)
}

function isToolingAttributeValue(value: unknown): value is AttributeValue {
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return true
  if (!Array.isArray(value)) return false
  const elementType = typeof value.find((element) => element != null)
  return value.every(
    (element) =>
      element == null ||
      ((elementType === 'string' ||
        elementType === 'number' ||
        elementType === 'boolean') &&
        typeof element === elementType)
  )
}

// Direct local subscriber: the reporters consume the original tooling schema,
// independently of request diagnostics and the optional application SDK adapter.
export function reportToolingSpans(events: readonly TraceEvent[]): void {
  for (const event of events) reporter.report(event)
}

export type LocalSpanTiming = {
  startTime?: import('@opentelemetry/api').SpanOptions['startTime']
  monotonicStartTime?: bigint
  wallStartTimeMs?: number
}

// The local recorder owns payloads, delivery and the end-once state.
export type ToolingSpanSource = {
  id: SpanId
  parentId?: SpanId
  startTime: bigint
  wallStartTimeMs: number
}

export function captureToolingSpanSource(
  options: LocalSpanTiming & {
    parent?: SpanId | null
  },
  parent?: ToolingSpanSource
): ToolingSpanSource {
  const time = options.startTime
  const epochMs = time === undefined ? undefined : getTimestamp(time)
  let monotonicStartTime = options.monotonicStartTime
  let wallStartTimeMs = options.wallStartTimeMs ?? epochMs
  if (monotonicStartTime === undefined || wallStartTimeMs === undefined) {
    const clock = getToolingClock()
    monotonicStartTime ??=
      epochMs === undefined
        ? clock.monotonic
        : epochMillisecondsToNanoseconds(epochMs) +
          clock.monotonic -
          BigInt(clock.wallTimeMs) * NUM_OF_MILLISEC_IN_NANOSEC
    wallStartTimeMs ??= clock.wallTimeMs
  }
  return {
    id: getId(),
    parentId:
      options.parent === null
        ? undefined
        : (options.parent ?? parent?.id ?? defaultParentSpanId),
    startTime: monotonicStartTime,
    wallStartTimeMs,
  }
}

/** Records the selected worker hierarchy independently of SDK availability. */
export function selectToolingSpanSource(
  source: ToolingSpanSource,
  parentSelectedId?: SpanId
): void {
  if (shouldSaveTraceEvents) {
    savedToolingSpanSelections.push({
      id: source.id,
      parentId: parentSelectedId ?? source.parentId,
    })
  }
}

// Multiply integer milliseconds as bigint so epoch magnitudes cannot lose the
// low nanoseconds before the clock correction is applied.
function epochMillisecondsToNanoseconds(time: number): bigint {
  const whole = Math.trunc(time)
  return (
    BigInt(whole) * NUM_OF_MILLISEC_IN_NANOSEC +
    BigInt(Math.trunc((time - whole) * 1_000_000))
  )
}

export function getToolingSpanEndTime(
  endTime?: Parameters<OpenTelemetrySpan['end']>[0]
): bigint {
  if (Array.isArray(endTime)) {
    return BigInt(endTime[0]) * NUM_OF_SEC_IN_NANOSEC + BigInt(endTime[1])
  } else if (endTime === undefined) {
    return process.hrtime.bigint()
  } else {
    const epochMs = endTime instanceof Date ? endTime.getTime() : endTime
    const clock = getToolingClock()
    const correction =
      clock.monotonic - BigInt(clock.wallTimeMs) * NUM_OF_MILLISEC_IN_NANOSEC
    const timeMs = getTimestamp(epochMs)
    return epochMillisecondsToNanoseconds(timeMs) + correction
  }
}

export function completeToolingSpan(
  source: ToolingSpanSource,
  name: string,
  attributes: Record<string, AttributeValue>,
  endTime?: Parameters<OpenTelemetrySpan['end']>[0],
  end = getToolingSpanEndTime(endTime)
): TraceEvent {
  const duration = (end - source.startTime) / NUM_OF_MICROSEC_IN_NANOSEC
  if (duration > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Duration is too long to express as float64: ${duration}`)
  }
  const event: TraceEvent = {
    name,
    id: source.id,
    parentId: source.parentId,
    timestamp: Number(source.startTime / NUM_OF_MICROSEC_IN_NANOSEC),
    duration: Number(duration),
    startTime: source.wallStartTimeMs,
    tags: attributes,
  }
  if (duration > RECORD_SPAN_THRESHOLD_MS * 1000) {
    reportToolingSpans([event])
    if (shouldSaveTraceEvents) savedTraceEvents.push(event)
  }
  return event
}

export const flushAllTraces = () => reporter.flushAll()

/**
 * Flush and release the trace file handle. Intended for tests that need to
 * delete the directory holding the trace afterwards.
 */
export const closeAllTraces = () => reporter.close()

// This code supports workers by serializing the state of tracers when the
// worker is initialized, and serializing the trace events from the worker back
// to the main process to record when the worker is complete.
export const exportTraceState = (): TraceState => ({
  defaultParentSpanId,
  lastId: count,
  shouldSaveTraceEvents,
  ...(shouldSaveTraceEvents
    ? { toolingSpanSelections: savedToolingSpanSelections.slice() }
    : {}),
  ...(replay
    ? {
        otelClockOffset: replay.getClockOffset(),
      }
    : {}),
})
export const initializeTraceState = (state: TraceState) => {
  count = state.lastId
  defaultParentSpanId = state.defaultParentSpanId
  shouldSaveTraceEvents = state.shouldSaveTraceEvents
  savedToolingSpanSelections = []

  if (replay) {
    replay.configureState(
      defaultParentSpanId,
      !!shouldSaveTraceEvents,
      state.otelClockOffset
    )
  }
}

export function getTraceEvents(): TraceEvent[] {
  return savedTraceEvents
}

export function recordTraceEvents(
  events: TraceEvent[],
  selections?: readonly ToolingSpanSelection[]
) {
  for (const traceEvent of events) {
    traceEvent.tags = normalizeToolingAttributes(traceEvent.tags)
    reportToolingSpans([traceEvent])
    if (traceEvent.id > count) {
      count = traceEvent.id + 1
    }
  }
  if (shouldSaveTraceEvents) {
    savedTraceEvents.push(...events)
  }
  replay?.replayWorkerEvents(events, selections)
}

export const clearTraceEvents = () => {
  savedToolingSpanSelections = []
  return (savedTraceEvents = [])
}

/**
 * Converts hrtime (process.hrtime.bigint()) to epoch-based nanoseconds.
 *
 * hrtime values are relative to an arbitrary point in the past, while
 * epoch-based times are nanoseconds since Unix epoch (Jan 1, 1970).
 *
 * This is useful when passing hrtime values to APIs that expect epoch-based times,
 * such as completed observations passed to recordSpans().
 */
export function hrtimeToEpochNanoseconds(hrtimeValue: bigint): bigint {
  const clock = getToolingClock()
  const offset =
    BigInt(clock.wallTimeMs) * NUM_OF_MILLISEC_IN_NANOSEC - clock.monotonic
  return hrtimeValue + offset
}
