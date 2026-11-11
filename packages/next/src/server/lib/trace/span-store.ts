import { getOrCreateGlobalAsyncLocalStorage } from '../../app-render/async-local-storage'
import type { TraceEvent } from '../../../trace/types'
import type { Span } from '@opentelemetry/api'

// Lazy for request-only/Edge users, cached for high-volume tooling imports.
let toolingTracing: typeof import('../../../trace/trace') | undefined
let toolingRecorder: typeof import('./local-span-recorder') | undefined

/** Completed native/manual observations use nanoseconds since Unix epoch. */
export type ToolingSpanObservation = {
  name: string
  startTime?: bigint
  endTime?: bigint
  attributes?: Record<string, unknown>
  reportToOtel?: boolean
  recordToInsights?: boolean
}
import type {
  RequestInsightKind,
  RequestInsightProxyStatus,
  RequestInsightSource,
} from '../../../shared/lib/request-insights'

export type SpanStoreAttributeValue =
  | string
  | number
  | boolean
  | Array<null | undefined | string>
  | Array<null | undefined | number>
  | Array<null | undefined | boolean>

export type SpanStoreAttributes = Record<string, SpanStoreAttributeValue>

export type SpanStoreLink = {
  traceId: string
  spanId: string
  attributes?: SpanStoreAttributes
}

export type SpanStoreEvent = {
  name: string
  timestamp: number
  attributes?: SpanStoreAttributes
}

export type SpanStoreRecord = {
  name: string
  timestamp: number
  startTime?: number
  durationMs?: number
  status?: 'ok' | 'error'
  traceId?: string
  spanId?: string
  parentSpanId?: string
  requestId?: string
  requestInsightKind?: RequestInsightKind
  requestInsightSource?: RequestInsightSource
  requestInsightProxyStatus?: RequestInsightProxyStatus
  requestInsightRoot?: boolean
  htmlRequestId?: string
  route?: string
  url?: string
  attributes?: SpanStoreAttributes
  links?: SpanStoreLink[]
  events?: SpanStoreEvent[]
  error?: {
    type?: string
    message?: string
  }
}

export type LocalSpanParent = {
  traceId: string
  spanId: string
}

export type LocalSpanBatch = {
  spans: SpanStoreRecord[]
  droppedSpanCount: number
}

type SpanRecorderForTest = (span: SpanStoreRecord) => void
type LocalSpanSink = (span: SpanStoreRecord) => void

let spanRecorderForTest: SpanRecorderForTest | undefined
type LocalSpanExporter = {
  isEnabled(): boolean
  export(spans: readonly SpanStoreRecord[]): void
}

let localSpanExporter: LocalSpanExporter | undefined

export function setLocalSpanExporter(exporter: LocalSpanExporter | undefined) {
  localSpanExporter = exporter
}

function getLocalSpanSinkStorage() {
  return getOrCreateGlobalAsyncLocalStorage<LocalSpanSink>('local-span-sink')
}

export function runWithLocalSpanSink<T>(sink: LocalSpanSink, fn: () => T): T {
  return getLocalSpanSinkStorage().run(sink, fn)
}

export function isLocalSpanSinkActive(): boolean {
  return getLocalSpanSinkStorage().getStore() !== undefined
}

export function recordSpan(record: Omit<SpanStoreRecord, 'timestamp'>): void {
  if (!isLocalSpanRecordingEnabled()) {
    return
  }

  const spanRecord: SpanStoreRecord = {
    timestamp: getCurrentTimestamp(),
    ...record,
  }

  recordSpans([spanRecord])
}

export function recordSpans(
  ...args:
    | [spans: readonly SpanStoreRecord[]]
    | [spans: readonly TraceEvent[], source: 'tooling']
    | [
        spans: readonly ToolingSpanObservation[],
        source: 'tooling',
        parentSpan: Span | undefined,
      ]
): void {
  if (args.length === 3) {
    if (process.env.NEXT_RUNTIME === 'edge') {
      return
    } else {
      const { getToolingClock } = (toolingTracing ??=
        require('../../../trace/trace') as typeof import('../../../trace/trace'))
      const { createLocalSpan } = (toolingRecorder ??=
        require('./local-span-recorder') as typeof import('./local-span-recorder'))
      const nsPerMs = BigInt(1_000_000)
      for (const observation of args[0]) {
        // Native events arrive after completion. Preserve their original wall
        // start and map both endpoints to the local monotonic clock together.
        const clock = getToolingClock()
        const correction = clock.monotonic - BigInt(clock.wallTimeMs) * nsPerMs
        const timing = {
          monotonicStartTime:
            observation.startTime !== undefined
              ? observation.startTime + correction
              : clock.monotonic,
          wallStartTimeMs:
            observation.startTime !== undefined
              ? Number(observation.startTime / nsPerMs)
              : clock.wallTimeMs,
        }
        const monotonicEndTime =
          observation.endTime !== undefined
            ? observation.endTime + correction
            : clock.monotonic
        createLocalSpan({
          name: observation.name,
          attributes: observation.attributes,
          parent: args[2],
          reportToOtel: observation.reportToOtel,
          recordToInsights: observation.recordToInsights,
          ...timing,
          monotonicEndTime,
        })
      }
    }
  } else if (args.length === 2) {
    // Tooling observations go straight to files in builds as well as dev, never
    // into the request sink/history or an application SDK provider.
    if (process.env.NEXT_RUNTIME === 'edge') {
      return
    } else {
      const { reportToolingSpans } = (toolingTracing ??=
        require('../../../trace/trace') as typeof import('../../../trace/trace'))
      reportToolingSpans(args[0])
    }
  } else {
    // Request observations retain creation-time sink ownership and dev gates.
    captureLocalSpanRecorder()(args[0])
  }
}

export function captureLocalSpanRecorder(): (
  spans: readonly SpanStoreRecord[]
) => void {
  const sink = getLocalSpanSinkStorage().getStore()
  return sink ? (spans) => exportSpans(spans, sink) : exportSpans
}

function exportSpans(
  spans: readonly SpanStoreRecord[],
  localSpanSink?: LocalSpanSink
): void {
  if (!process.env.__NEXT_DEV_SERVER || spans.length === 0) {
    return
  }

  for (const span of spans) {
    try {
      localSpanSink?.(span)
    } catch {
      // A scoped collector must not interrupt application work or later spans.
    }
    spanRecorderForTest?.(span)
  }

  if (!localSpanSink && localSpanExporter?.isEnabled()) {
    try {
      localSpanExporter.export(spans)
    } catch {
      // Recording diagnostics must not interrupt application work.
    }
  }
}

export function setSpanRecorderForTest(
  recorder: SpanRecorderForTest | undefined
): void {
  spanRecorderForTest = recorder
}

export function isLocalSpanRecordingEnabled(): boolean {
  if (!process.env.__NEXT_DEV_SERVER) {
    return false
  }

  return (
    isLocalSpanSinkActive() ||
    spanRecorderForTest !== undefined ||
    (localSpanExporter?.isEnabled() ?? false)
  )
}

export function isRequestInsightsEnabled(): boolean {
  if (!process.env.__NEXT_DEV_SERVER) {
    return false
  }

  const value = process.env.__NEXT_REQUEST_INSIGHTS
  return isEnabledEnvValue(value)
}

function isEnabledEnvValue(value: string | undefined): boolean {
  return value === '1' || value === 'true' || (value as unknown) === true
}

function getCurrentTimestamp(): number {
  return performance.timeOrigin + performance.now()
}
