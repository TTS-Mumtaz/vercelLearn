import type {
  AttributeValue,
  Attributes,
  Context,
  SpanStatus,
  Span,
  SpanContext,
  SpanOptions,
  SpanStatusCode,
} from '@opentelemetry/api'
import type {
  SpanStoreAttributes,
  SpanStoreEvent,
  SpanStoreLink,
  SpanStoreRecord,
  LocalSpanParent,
} from './span-store'
import type { ToolingSpanSource } from '../../../trace/trace'
import type { SpanId } from '../../../trace/types'
import { getOrCreateGlobalAsyncLocalStorage } from '../../app-render/async-local-storage'
import { getTimestamp, toHrTime } from './utils'
import type {
  ReportingToken,
  ReportingStart,
  ReportingCompletion,
  ReplaySnapshot,
} from './local-span-replay.node'

export { isLocalSpanRecordingEnabled } from './span-store'

const TRACE_ID_HEX_LENGTH = 32
const SPAN_ID_HEX_LENGTH = 16
// The OTel status code is part of its public API. Keep recording independent of
// loading the runtime API.
const SPAN_STATUS_ERROR: SpanStatusCode = 2

type LocalSpanAttributes = Partial<Record<string, AttributeValue | undefined>>

export type LocalSpanOptions = {
  name: string
  attributes?: Record<string, unknown>
  parent?: Span | SpanId | null
  links?: SpanOptions['links']
  /** Public OTel timestamp (epoch/relative milliseconds, Date or HrTime). */
  startTime?: SpanOptions['startTime']
  endTime?: Parameters<Span['end']>[0]
  monotonicEndTime?: bigint
  /** Lossless process.hrtime.bigint() timestamp, independent of wall time. */
  monotonicStartTime?: bigint
  wallStartTimeMs?: number
  traceId?: string
  spanId?: string
  delegateSpan?: Span
  openTelemetry?: { options: SpanOptions; context: Context }
  publicParentSpan?: Span
  isolateOpenTelemetry?: boolean
  reportToOtel?: boolean
  recordToInsights?: boolean
  reportingRoot?: boolean
}

export type LocalSpanDelivery = (spans: readonly SpanStoreRecord[]) => void

type TraceExistingLocalSpanOptions = {
  span: LocalRecordingSpan
}

// Keep request-only/Edge imports independent of the tooling module. Cache its
// lazy load: even a cached require otherwise repeats resolution on every span.
let toolingTracing: typeof import('../../../trace/trace') | undefined
let toolingReplay: typeof import('./local-span-replay.node') | undefined
function getToolingReplay() {
  if (process.env.NEXT_RUNTIME === 'edge') {
    return undefined
  } else {
    return (toolingReplay ??=
      require('./local-span-replay.node') as typeof import('./local-span-replay.node'))
  }
}

type ToolingReporting = {
  source: ToolingSpanSource
  parent?: ReportingToken
  selectedId?: number
  token?: ReportingToken
  name: string
}
const toolingReporting = new WeakMap<Span, ToolingReporting>()
let delivering = false
const pendingReporting = new Map<ReportingToken, ReplaySnapshot>()

export type LocalSpanDelegate = {
  span?: Span
  context?: SpanContext
  onError?: () => void
  eventsForwarded?: number
}
export type LocalSpanCompletion = {
  name?: string
  attributes?: Parameters<Span['setAttributes']>[0]
  events?: SpanStoreEvent[]
  status?: SpanStatus
}

function canUseDelegate() {
  return true
}

/** Internal numeric identity/clock metadata, independent of public OTel IDs. */
export function getToolingSpanSource(
  span: Span
): ToolingSpanSource | undefined {
  return toolingReporting.get(span)?.source
}

let lastLocalTraceId = 0
let lastLocalSpanId = 0

function getLocalTraceId(): string {
  return (++lastLocalTraceId).toString(16).padStart(TRACE_ID_HEX_LENGTH, '0')
}

export function createLocalSpanId(excludedId?: string): string {
  let spanId: string
  do {
    spanId = (++lastLocalSpanId).toString(16).padStart(SPAN_ID_HEX_LENGTH, '0')
  } while (spanId === excludedId)
  return spanId
}

/**
 * Local creation never captures request state. A caller may supply completed
 * record delivery; otherwise the existing direct file reporter owns delivery.
 * Numeric parents carry correlation only, never a public SDK context.
 */
export function createLocalSpan(
  options: LocalSpanOptions,
  recordSpans?: LocalSpanDelivery
): LocalRecordingSpan {
  const parent = typeof options.parent === 'object' ? options.parent : undefined
  const parentContext = parent?.spanContext()
  let source: ToolingSpanSource | undefined
  let attributes = options.attributes as LocalSpanAttributes | undefined
  if (!recordSpans) {
    if (process.env.NEXT_RUNTIME !== 'edge') {
      const { captureToolingSpanSource, normalizeToolingAttributes } =
        (toolingTracing ??=
          require('../../../trace/trace') as typeof import('../../../trace/trace'))
      source = captureToolingSpanSource(
        {
          parent:
            typeof options.parent === 'number' || options.parent === null
              ? options.parent
              : undefined,
          startTime: options.startTime,
          monotonicStartTime: options.monotonicStartTime,
          wallStartTimeMs: options.wallStartTimeMs,
        },
        parent ? getToolingSpanSource(parent) : undefined
      )
      attributes = normalizeToolingAttributes(options.attributes)
    } else {
      throw new Error(
        'Default local file delivery is not available in the Edge runtime'
      )
    }
  }
  const delegate: LocalSpanDelegate = { span: options.delegateSpan }
  if (options.openTelemetry) {
    LocalRecordingSpan.startDelegate(
      delegate,
      options.name,
      options.openTelemetry.options,
      options.openTelemetry.context
    )
  }
  const delegateContext = delegate.span?.spanContext()
  const span = new LocalRecordingSpan({
    name: options.name,
    attributes,
    links: options.links,
    startTime: options.startTime,
    delegate,
    publicParentSpan: options.publicParentSpan,
    traceId:
      delegateContext?.traceId ??
      options.traceId ??
      parentContext?.traceId ??
      getLocalTraceId(),
    spanId: delegateContext?.spanId ?? options.spanId ?? createLocalSpanId(),
    parentSpanId: parentContext?.spanId,
    recordSpans,
    isolateOpenTelemetry: options.isolateOpenTelemetry ?? true,
  })
  if (source) {
    const ancestor = parent ? toolingReporting.get(parent) : undefined
    toolingReporting.set(span, {
      source,
      name: options.name,
      parent: ancestor?.token ?? ancestor?.parent,
      selectedId: ancestor?.selectedId,
    })
    if (process.env.NEXT_RUNTIME !== 'edge') {
      if (options.recordToInsights && process.env.__NEXT_DEV_SERVER) {
        const { captureToolingSpanRecorder } =
          require('./request-span-recorder') as typeof import('./request-span-recorder')
        const type = attributes?.['next.span_type']
        span.setDelivery(
          captureToolingSpanRecorder(
            span,
            parent ?? undefined,
            options.name,
            typeof type === 'string' ? type : options.name
          )
        )
      }
      if (options.reportToOtel) {
        span.startReporting(
          options.reportingRoot,
          options.endTime !== undefined ||
            options.monotonicEndTime !== undefined
        )
      }
    }
  }
  if (options.monotonicEndTime !== undefined)
    span.endMonotonic(options.monotonicEndTime)
  else if (options.endTime !== undefined) span.end(options.endTime)
  return span
}

export function getActiveLocalSpan(): Span | undefined {
  return getLocalSpanAsyncStorage().getStore()?.span
}

export function getLocalParentSpan(
  publicContext: SpanContext | undefined
): Span | undefined {
  const store = getLocalSpanAsyncStorage().getStore()
  // Tooling has its own explicit numeric hierarchy. A request started while a
  // coarse compiler scope is active must not adopt that tooling parent.
  if (!store || toolingReporting.has(store.span)) return undefined
  if (isOpenTelemetryIsolatedSpan(store.span)) return store.span

  // An SDK span opened inside this local scope is the nearer parent.
  if (
    publicContext?.traceId === store.publicContext?.traceId &&
    publicContext?.spanId === store.publicContext?.spanId
  ) {
    return store.span
  }
  return undefined
}

export function getOpenTelemetrySpan(span: Span): Span | undefined {
  return span instanceof LocalRecordingSpan ? span.getOpenTelemetrySpan() : span
}

export function reparentLocalSpans(
  parent: LocalSpanParent,
  spans: readonly SpanStoreRecord[]
): SpanStoreRecord[] {
  const importedIds = new Map<string, string>()
  const key = (traceId: string, spanId: string) => `${traceId}:${spanId}`
  for (const span of spans) {
    if (span.traceId && span.spanId) {
      importedIds.set(
        key(span.traceId, span.spanId),
        createLocalSpanId(parent.spanId)
      )
    }
  }

  return spans.map((span) => ({
    ...span,
    traceId: parent.traceId,
    spanId:
      (span.traceId && span.spanId
        ? importedIds.get(key(span.traceId, span.spanId))
        : undefined) ?? createLocalSpanId(parent.spanId),
    parentSpanId:
      (span.traceId && span.parentSpanId
        ? importedIds.get(key(span.traceId, span.parentSpanId))
        : undefined) ?? parent.spanId,
    links: span.links?.map((link) => {
      const spanId = importedIds.get(key(link.traceId, link.spanId))
      return spanId ? { ...link, traceId: parent.traceId, spanId } : link
    }),
  }))
}

export function isLocalRecordingSpan(span: Span): boolean {
  return span instanceof LocalRecordingSpan
}

export function isOpenTelemetryIsolatedSpan(span: Span): boolean {
  return span instanceof LocalRecordingSpan && span.isOpenTelemetryIsolated()
}

export function withLocalSpan<T>(
  span: Span,
  fn: () => T,
  publicContext?: SpanContext
): T {
  return getLocalSpanAsyncStorage().run({ span, publicContext }, fn)
}

/**
 * Scope is explicit so fine observations do not change surrounding parentage.
 *
 * The default remains asynchronous, including setup errors. Explicit synchronous
 * mode ends on return/throw without awaiting a returned promise.
 */
export function traceLocalSpan<T>(
  options: (LocalSpanOptions | TraceExistingLocalSpanOptions) & {
    synchronous: true
    scope?: boolean
  },
  fn: (span: LocalRecordingSpan) => T
): T
export function traceLocalSpan<T>(
  options: (LocalSpanOptions | TraceExistingLocalSpanOptions) & {
    synchronous?: false
    scope?: boolean
  },
  fn: (span: LocalRecordingSpan) => T | Promise<T>
): Promise<T>
export function traceLocalSpan<T>(
  options: (LocalSpanOptions | TraceExistingLocalSpanOptions) & {
    synchronous?: boolean
    scope?: boolean
  },
  fn: (span: LocalRecordingSpan) => T | Promise<T>
): T | Promise<T> {
  const synchronous = options.synchronous ?? false
  const run = () => {
    let span: LocalRecordingSpan
    if ('span' in options) {
      // Some hook-delimited operations start before their callback is available.
      // Reuse their recorder and the same callback lifecycle, not a second span.
      span = options.span
    } else {
      span = createLocalSpan({
        ...options,
        parent:
          options.scope && options.parent === undefined
            ? getActiveLocalSpan()
            : options.parent,
      })
    }
    const tooling = toolingReporting.has(span)
    const fail = (err: unknown): never => {
      if (tooling) span.setAttribute('failed', true)
      if (tooling && options.scope) {
        const { recordSpanError } =
          require('./tracer') as typeof import('./tracer')
        recordSpanError(span, err as Error)
      } else {
        span.recordException(err as Error)
        span.setStatus({ code: SPAN_STATUS_ERROR })
      }
      throw err
    }

    const execute = () => {
      let pending: Promise<T> | undefined
      try {
        const result = fn(span)
        if (synchronous) return result
        pending = Promise.resolve(result)
          .catch(fail)
          .finally(() => span.end())
        return pending
      } catch (err) {
        return fail(err)
      } finally {
        if (!pending) span.end()
      }
    }
    if (options.scope) {
      const { api } = require('./otel-api') as typeof import('./otel-api')
      const { context, ROOT_CONTEXT } = api
      return context.with(ROOT_CONTEXT, () => withLocalSpan(span, execute))
    }
    return execute()
  }

  return synchronous ? run() : (async () => run())()
}

function getLocalSpanAsyncStorage() {
  return getOrCreateGlobalAsyncLocalStorage<{
    span: Span
    publicContext: SpanContext | undefined
  }>('local-span-storage')
}

export class LocalRecordingSpan implements Span {
  public name: string
  private nameUpdated = false

  private attributes: SpanStoreAttributes
  private events: SpanStoreEvent[]
  private readonly spanContextValue: ReturnType<Span['spanContext']>
  private readonly openTelemetryIsolated: boolean
  private readonly delegate: LocalSpanDelegate
  private openTelemetrySpan: Span | undefined
  private readonly openTelemetrySpanContext: SpanContext | undefined
  private links?: SpanStoreLink[]
  private readonly parentSpanId?: string
  private recordSpans: LocalSpanDelivery | undefined
  private readonly startTime: number
  private statusCode: number | undefined
  private statusMessage: string | undefined
  private exception:
    | {
        type?: string
        message?: string
      }
    | undefined
  private ended: boolean

  constructor({
    name,
    attributes,
    links,
    startTime,
    delegateSpan,
    delegate = { span: delegateSpan },
    publicParentSpan,
    traceId,
    spanId,
    parentSpanId,
    recordSpans,
    isolateOpenTelemetry,
  }: {
    name: string
    attributes?: LocalSpanAttributes
    links?: SpanOptions['links']
    startTime?: SpanOptions['startTime']
    delegateSpan?: Span
    delegate?: LocalSpanDelegate
    publicParentSpan?: Span
    traceId: string
    spanId: string
    parentSpanId?: string
    recordSpans?: LocalSpanDelivery
    isolateOpenTelemetry: boolean
  }) {
    this.name = name
    this.attributes = cleanSpanStoreAttributes(attributes)
    this.events = []
    this.delegate = delegate
    this.openTelemetrySpan = delegate.span ?? publicParentSpan
    this.openTelemetrySpanContext = this.openTelemetrySpan?.spanContext()
    this.openTelemetryIsolated = isolateOpenTelemetry
    this.spanContextValue = delegate.span?.spanContext() ?? {
      traceId,
      spanId,
      traceFlags: 0,
    }
    this.links = getSpanStoreLinks(links)
    this.parentSpanId = parentSpanId
    // Delivery is bound by the caller before entering the recorder.
    this.recordSpans = recordSpans
    this.startTime = getTimestamp(startTime)
    this.statusCode = undefined
    this.statusMessage = undefined
    this.exception = undefined
    this.ended = false
  }

  startReporting(root = false, completed = false): void {
    const reporting = toolingReporting.get(this)!
    const { source } = reporting
    toolingTracing!.selectToolingSpanSource(source, reporting.selectedId)
    reporting.selectedId = source.id
    const replay = getToolingReplay()!
    const token = (reporting.token = replay.prepare(
      this.delegate,
      source.id,
      source.parentId,
      reporting.parent,
      root
    ))
    if (token && !completed)
      LocalRecordingSpan.deliverToolingSpan(token, this.getReportingStart())
  }

  static startDelegate(
    delegate: LocalSpanDelegate,
    name: string,
    options: SpanOptions,
    parentContext: Context,
    canUse = canUseDelegate
  ): void {
    if (delegate.span || !canUse()) return
    const { getTracerInstance } =
      require('./otel-api') as typeof import('./otel-api')
    const tracer = getTracerInstance()
    if (!canUse()) return
    const span = tracer.startSpan(name, options, parentContext)
    if (!canUse()) return
    delegate.span = span
    const spanContext = span.spanContext()
    if (!canUse()) return
    delegate.context = spanContext
  }

  static endDelegate(
    delegate: LocalSpanDelegate,
    endTime?: Parameters<Span['end']>[0],
    completion?: LocalSpanCompletion,
    canUse = canUseDelegate
  ): void {
    const span = delegate.span
    if (!span || !canUse()) return
    if (completion?.name) {
      span.updateName(completion.name)
      if (!canUse()) return
    }
    if (completion?.attributes) {
      span.setAttributes(completion.attributes)
      if (!canUse()) return
    }
    LocalRecordingSpan.deliverEvents(delegate, completion?.events ?? [], canUse)
    if (!canUse()) return
    if (completion?.status) {
      span.setStatus(completion.status)
      if (!canUse()) return
    }
    try {
      span.end(endTime)
    } finally {
      if (delegate.span === span) delegate.span = undefined
    }
  }

  static deliverEvents(
    delegate: LocalSpanDelegate,
    events: SpanStoreEvent[],
    canUse = canUseDelegate
  ): void {
    for (let i = delegate.eventsForwarded ?? 0; i < events.length; i++) {
      if (!delegate.span || !canUse()) return
      const event = events[i]
      delegate.span.addEvent(event.name, event.attributes, event.timestamp)
      if (!canUse()) return
      delegate.eventsForwarded = i + 1
    }
  }

  static clearReporting(): void {
    for (const item of pendingReporting.values())
      toolingReplay!.releaseSnapshot(item)
    pendingReporting.clear()
  }

  static deliverToolingSpan(
    token?: ReportingToken,
    start?: ReportingStart,
    completion?: ReportingCompletion
  ): void {
    const replay = getToolingReplay()!
    if (token && start) {
      if (!replay.isCurrent(token)) return
      if (!replay.isReady(token) || delivering) {
        const item = replay.snapshot(
          token,
          start,
          completion,
          pendingReporting.get(token)
        )
        if (item) pendingReporting.set(token, item)
        if (replay.isReady(token) && !delivering)
          LocalRecordingSpan.deliverToolingSpan()
        return
      }
    }
    if (delivering) return
    delivering = true
    try {
      if (token && start)
        LocalRecordingSpan.emitToolingSpan(token, start, completion)
      while (pendingReporting.size) {
        const item =
          pendingReporting.get(replay.getRoot()!) ??
          pendingReporting.values().next().value!
        if (replay.isCurrent(item.token) && !replay.isReady(item.token)) break
        pendingReporting.delete(item.token)
        replay.releaseSnapshot(item)
        LocalRecordingSpan.emitToolingSpan(
          item.token,
          item.start,
          item.completion
        )
      }
    } finally {
      delivering = false
    }
  }

  private static emitToolingSpan(
    token: ReportingToken,
    start: ReportingStart,
    completion?: ReportingCompletion
  ): void {
    const replay = toolingReplay!
    const canUse = () => replay.isReady(token)
    if (!canUse()) return
    try {
      const { api } = require('./otel-api') as typeof import('./otel-api')
      const parent = replay.parentContext(token)
      const context = parent
        ? api.trace.setSpanContext(api.ROOT_CONTEXT, parent)
        : api.ROOT_CONTEXT
      const metricsOnly =
        start.name === 'memory-usage' ||
        start.name === 'server-restart-close-to-memory-threshold'
      const completedAtStart = !!completion && !token.span
      const attributes = Object.fromEntries(
        Object.entries(completion?.attributes ?? {}).map(([key, value]) => [
          key,
          Array.isArray(value) ? JSON.stringify(value) : value,
        ])
      )
      if (!canUse()) return
      if (!metricsOnly && !token.span) {
        LocalRecordingSpan.startDelegate(
          token,
          completion?.name ?? start.name,
          {
            startTime: toHrTime(start.start),
            links: start.links,
            attributes: {
              'next.tooling.id': token.id,
              ...(start.parentId === undefined
                ? {}
                : { 'next.tooling.parent_id': start.parentId }),
              ...(completion ? attributes : undefined),
            },
          },
          context,
          canUse
        )
      }
      if (!completion || !canUse()) return
      const metricParent = token.context ?? parent ?? replay.getRoot()?.context
      LocalRecordingSpan.reportMeasurements(
        start.name,
        attributes,
        metricParent
          ? api.trace.setSpanContext(api.ROOT_CONTEXT, metricParent)
          : context,
        canUse
      )
      if (!canUse()) return
      LocalRecordingSpan.endDelegate(
        token,
        toHrTime(completion.end),
        {
          ...completion,
          name: completedAtStart ? undefined : completion.name,
          attributes: completedAtStart ? undefined : attributes,
          status:
            completion.status ??
            (attributes.failed === true
              ? { code: SPAN_STATUS_ERROR }
              : undefined),
        },
        canUse
      )
      if (canUse()) replay.finish(token)
    } catch {
      replay.finish(token, true)
    }
  }

  private static reportMeasurements(
    name: string,
    attributes: Attributes,
    context: Context,
    canUse: () => boolean
  ): void {
    const restart = name === 'server-restart-close-to-memory-threshold'
    const native =
      name === 'turbopack-persistence' || name === 'turbopack-compaction'
    if (!native && name !== 'memory-usage' && !restart) return
    const { api } = require('./otel-api') as typeof import('./otel-api')
    const meter = api.metrics.getMeter('next.js', process.env.__NEXT_VERSION)
    const measurements = native
      ? [
          ['bytes_written', 'turbopack.bytes_written', 'By'],
          ['bytes_deleted', 'turbopack.bytes_deleted', 'By'],
          ['task_count', 'turbopack.task_count', '{task}'],
        ]
      : [
          ['memory.rss', 'memory.rss', 'By'],
          ['memory.heapUsed', 'memory.heap_used', 'By'],
          ['memory.heapTotal', 'memory.heap_total', 'By'],
          ['memory.heapMax', 'memory.heap_limit', 'By'],
          ['memory.heapSizeLimit', 'memory.heap_limit', 'By'],
        ]
    for (const [key, suffix, unit] of measurements) {
      if (attributes[key] === undefined) continue
      const value = Number(attributes[key])
      if (!Number.isFinite(value) || value < 0 || !canUse()) continue
      const histogram = meter.createHistogram(`next.tooling.${suffix}`, {
        unit,
      })
      if (!canUse()) return
      histogram.record(value, { operation: name }, context)
    }
    if (restart && canUse())
      meter
        .createCounter('next.tooling.server.restarts', { unit: '{restart}' })
        .add(1, { reason: 'memory-threshold' }, context)
  }

  private getReportingStart(): ReportingStart {
    const { source, name } = toolingReporting.get(this)!
    return {
      name,
      parentId: source.parentId,
      start: toolingReplay!.epochTime(source.startTime),
      links: this.delegate.span
        ? undefined
        : this.links?.map(({ traceId, spanId, attributes }) => ({
            context: { traceId, spanId, traceFlags: 0 },
            attributes,
          })),
    }
  }

  private updateDelegate(update: (span: Span) => void): void {
    const span = this.delegate.span
    const token = toolingReporting.get(this)?.token
    if (!span || (token && !toolingReplay!.isReady(token))) return
    if (!toolingReporting.has(this)) {
      update(span)
      return
    }
    try {
      update(span)
    } catch {
      this.delegate.onError?.()
    }
  }

  setDelivery(deliver: LocalSpanDelivery): void {
    this.recordSpans = deliver
  }

  spanContext(): ReturnType<Span['spanContext']> {
    return this.spanContextValue
  }

  isOpenTelemetryIsolated(): boolean {
    return this.openTelemetryIsolated
  }

  getOpenTelemetrySpan(): Span | undefined {
    return (
      this.delegate.span ??
      this.openTelemetrySpan ??
      ((this.delegate.context ?? this.openTelemetrySpanContext)
        ? (
            require('./otel-api') as typeof import('./otel-api')
          ).api.trace.wrapSpanContext(
            (this.delegate.context ?? this.openTelemetrySpanContext)!
          )
        : undefined)
    )
  }

  setAttribute(key: string, value: AttributeValue): this {
    if (this.ended && !toolingReporting.has(this)) {
      return this
    }

    this.attributes[key] = value
    this.updateDelegate((span) => span.setAttribute(key, value))
    return this
  }

  setAttributes(attributes: Parameters<Span['setAttributes']>[0]): this {
    if (this.ended && !toolingReporting.has(this)) {
      return this
    }

    // OpenTelemetry attributes may be undefined. Ignore them instead of
    // overwriting an existing value as Object.assign would.
    for (const key of Object.keys(attributes)) {
      const value = attributes[key]
      if (value !== undefined) {
        this.attributes[key] = value
      }
    }
    this.updateDelegate((span) => span.setAttributes(attributes))
    return this
  }

  addEvent(
    name: string,
    attributesOrStartTime?: Parameters<Span['addEvent']>[1],
    startTime?: Parameters<Span['addEvent']>[2]
  ): this {
    if (this.ended) {
      return this
    }

    const eventTime =
      startTime === undefined && isTimestampInput(attributesOrStartTime)
        ? attributesOrStartTime
        : startTime
    this.events.push({
      name,
      timestamp: getTimestamp(eventTime),
      attributes: isSpanStoreAttributes(attributesOrStartTime)
        ? cleanSpanStoreAttributes(attributesOrStartTime)
        : undefined,
    })
    if (!toolingReporting.has(this)) {
      this.delegate.span?.addEvent(name, attributesOrStartTime, startTime)
    } else {
      this.updateDelegate(() =>
        LocalRecordingSpan.deliverEvents(this.delegate, this.events, () =>
          toolingReplay!.isReady(toolingReporting.get(this)!.token!)
        )
      )
    }
    return this
  }

  setStatus(status: Parameters<Span['setStatus']>[0]): this {
    if (this.ended) {
      return this
    }

    this.statusCode = status.code
    this.statusMessage = status.message
    this.updateDelegate((span) => span.setStatus(status))
    return this
  }

  updateName(name: string): this {
    if (this.ended) {
      return this
    }

    this.name = name
    this.nameUpdated = true
    this.updateDelegate((span) => span.updateName(name))
    return this
  }

  end(endTime?: Parameters<Span['end']>[0]): void {
    if (this.ended) {
      return
    }

    this.finish(endTime)
  }

  private finish(
    endTime?: Parameters<Span['end']>[0],
    monotonicEndTime?: bigint
  ): void {
    if (this.ended) return
    this.ended = true
    try {
      if (!toolingReporting.has(this))
        LocalRecordingSpan.endDelegate(this.delegate, endTime)
    } finally {
      try {
        this.record(endTime, monotonicEndTime)
      } finally {
        this.releaseReferences()
      }
    }
  }

  isRecording(): boolean {
    return !this.ended
  }

  recordException(
    exception: Parameters<Span['recordException']>[0],
    time?: Parameters<Span['recordException']>[1]
  ): void {
    if (this.ended) {
      return
    }

    this.exception = getSpanStoreException(exception)
    this.events.push({
      name: 'exception',
      timestamp: getTimestamp(time),
      attributes: getSpanStoreExceptionAttributes(this.exception),
    })
    if (!toolingReporting.has(this)) {
      this.delegate.span?.recordException(exception, time)
    } else {
      this.updateDelegate(() =>
        LocalRecordingSpan.deliverEvents(this.delegate, this.events, () =>
          toolingReplay!.isReady(toolingReporting.get(this)!.token!)
        )
      )
    }
  }

  endMonotonic(endTime: bigint): void {
    this.finish(undefined, endTime)
  }

  private record(
    endTime: Parameters<Span['end']>[0],
    monotonicEndTime?: bigint
  ): void {
    let completedAt = getTimestamp(endTime)
    let startTime = this.startTime
    const source = toolingReporting.get(this)?.source
    if (source && process.env.NEXT_RUNTIME !== 'edge') {
      const { completeToolingSpan, getToolingSpanEndTime } = (toolingTracing ??=
        require('../../../trace/trace') as typeof import('../../../trace/trace'))
      const stopTime = monotonicEndTime ?? getToolingSpanEndTime(endTime)
      let event: ReturnType<typeof completeToolingSpan>
      try {
        event = completeToolingSpan(
          source,
          this.name,
          this.attributes,
          endTime,
          stopTime
        )
      } finally {
        const token = toolingReporting.get(this)?.token
        if (token && toolingReplay) {
          LocalRecordingSpan.deliverToolingSpan(
            token,
            this.getReportingStart(),
            {
              end: toolingReplay.epochTime(stopTime),
              attributes: this.attributes,
              name: this.nameUpdated ? this.name : undefined,
              events: this.events.length ? this.events : undefined,
              status:
                this.statusCode === undefined
                  ? undefined
                  : {
                      code: this.statusCode,
                      message: this.statusMessage,
                    },
            }
          )
        }
      }
      startTime = source.wallStartTimeMs
      completedAt = startTime + event.duration / 1000
      if (!this.recordSpans) return
    }
    const recordAttributes =
      Object.keys(this.attributes).length > 0 ? this.attributes : undefined

    this.recordSpans?.([
      {
        timestamp: getTimestamp(),
        name: this.name,
        startTime,
        durationMs: Math.max(0, completedAt - startTime),
        status: this.statusCode === SPAN_STATUS_ERROR ? 'error' : 'ok',
        traceId: this.spanContextValue.traceId,
        spanId: this.spanContextValue.spanId,
        parentSpanId: this.parentSpanId,
        route:
          getStringAttribute(recordAttributes, 'next.route') ??
          getStringAttribute(recordAttributes, 'http.route'),
        url: getStringAttribute(recordAttributes, 'http.url'),
        attributes: recordAttributes,
        links: this.links,
        events: this.events.length > 0 ? this.events : undefined,
        error: this.getRecordError(),
      },
    ])
  }

  private releaseReferences(): void {
    // AsyncLocalStorage can keep an ended span reachable when work spawned
    // inside the span outlives it. Keep only the immutable span context and
    // primitive timing/identity fields needed by the Span API after end.
    // Legacy saved tooling events retain the normalized tag object and permit
    // late attribute writes. Request spans release it and ignore later writes.
    if (!toolingReporting.has(this)) {
      this.name = ''
      this.attributes = {}
    }
    this.events = []
    if (!toolingReporting.has(this)) this.delegate.span = undefined
    this.openTelemetrySpan = undefined
    this.links = undefined
    this.recordSpans = undefined
    this.statusMessage = undefined
    this.exception = undefined
  }

  private getRecordError():
    | {
        type?: string
        message?: string
      }
    | undefined {
    if (this.exception) {
      return this.exception
    }

    if (this.statusCode === SPAN_STATUS_ERROR && this.statusMessage) {
      return {
        message: this.statusMessage,
      }
    }

    return undefined
  }
}

function getSpanStoreLinks(
  links: SpanOptions['links'] | undefined
): SpanStoreLink[] | undefined {
  const spanStoreLinks = links?.map((link) => ({
    traceId: link.context.traceId,
    spanId: link.context.spanId,
    attributes: cleanSpanStoreAttributes(link.attributes),
  }))

  return spanStoreLinks?.length ? spanStoreLinks : undefined
}

function cleanSpanStoreAttributes(
  attributes:
    | Record<string, AttributeValue | undefined>
    | SpanStoreAttributes
    | undefined
): SpanStoreAttributes {
  const cleanedAttributes: SpanStoreAttributes = {}
  if (attributes) {
    for (const key of Object.keys(attributes)) {
      const value = attributes[key]
      if (value !== undefined) {
        cleanedAttributes[key] = value
      }
    }
  }
  return cleanedAttributes
}

function getStringAttribute(
  attributes: SpanStoreAttributes | undefined,
  key: string
): string | undefined {
  const value = attributes?.[key]
  return typeof value === 'string' ? value : undefined
}

function isSpanStoreAttributes(
  value: Parameters<Span['addEvent']>[1]
): value is SpanStoreAttributes {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  )
}

function isTimestampInput(
  value: Parameters<Span['addEvent']>[1]
): value is SpanOptions['startTime'] {
  return (
    typeof value === 'number' || Array.isArray(value) || value instanceof Date
  )
}

function getSpanStoreException(
  exception: Parameters<Span['recordException']>[0]
):
  | {
      type?: string
      message?: string
    }
  | undefined {
  if (exception instanceof Error) {
    return {
      type: exception.name,
      message: exception.message,
    }
  }

  if (typeof exception === 'string') {
    return {
      message: exception,
    }
  }

  if (exception && typeof exception === 'object') {
    return {
      type: exception.constructor?.name,
      message: 'message' in exception ? String(exception.message) : undefined,
    }
  }

  return undefined
}

function getSpanStoreExceptionAttributes(
  exception:
    | {
        type?: string
        message?: string
      }
    | undefined
): SpanStoreAttributes | undefined {
  if (!exception) {
    return undefined
  }

  const attributes: SpanStoreAttributes = {}
  if (exception.type !== undefined) {
    attributes['exception.type'] = exception.type
  }
  if (exception.message !== undefined) {
    attributes['exception.message'] = exception.message
  }
  return Object.keys(attributes).length > 0 ? attributes : undefined
}
