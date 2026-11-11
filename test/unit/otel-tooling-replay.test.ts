import type { Span } from '@opentelemetry/api'
import type { ReadableSpan, Sampler } from '@opentelemetry/sdk-trace'
import type { TraceEvent } from '../../packages/next/src/trace/types'

// Real dev/build behavior is covered by test/e2e/app-dir/otel-tooling.
// Keep only safety conditions that cannot be reliably induced in that fixture.
describe('tooling OTel safety', () => {
  let api: typeof import('@opentelemetry/api')
  let sdk: typeof import('@opentelemetry/sdk-trace')
  let backend: typeof import('../../packages/next/src/server/lib/trace/local-span-replay.node')
  let recorder: typeof import('../../packages/next/src/server/lib/trace/local-span-recorder')
  let local: TraceEvent[]
  let exported: ReadableSpan[]

  beforeEach(() => {
    jest.resetModules()
    api = require('next/dist/compiled/@opentelemetry/api')
    api.trace.disable()
    api.metrics.disable()
    local = []
    exported = []
    jest.doMock('../../packages/next/src/trace/report', () => ({
      reporter: { report: (event: TraceEvent) => local.push(event) },
    }))
    require('../../packages/next/src/trace/trace').initializeTraceState({
      lastId: 0,
    })
    sdk = require('@opentelemetry/sdk-trace')
    backend = require('../../packages/next/src/server/lib/trace/local-span-replay.node')
    recorder = require('../../packages/next/src/server/lib/trace/local-span-recorder')
  })

  afterEach(async () => {
    backend.closeReporting()
    jest.dontMock('../../packages/next/src/trace/report')
    api.trace.disable()
    api.metrics.disable()
    api.context.disable()
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  function installProvider(
    onStart: (span: ReadableSpan) => void = () => {},
    sampler?: Sampler
  ) {
    expect(
      api.trace.setGlobalTracerProvider(
        new sdk.TracerProvider({
          sampler,
          spanProcessors: [
            {
              onStart,
              onEnd: (span) => exported.push(span),
              async forceFlush() {},
              async shutdown() {},
            },
          ],
        })
      )
    ).toBe(true)
  }

  function child(name: string, parent?: Span | number) {
    return recorder.createLocalSpan({ name, parent, reportToOtel: true })
  }

  function buildRoot(name = 'next-build') {
    return recorder.createLocalSpan({
      name,
      reportToOtel: true,
      reportingRoot: true,
    })
  }

  it('selects external reporting by property instead of operation name', () => {
    installProvider()
    const root = buildRoot()
    backend.enableReporting()
    recorder.createLocalSpan({ name: 'run-webpack', parent: root }).end()
    child('custom-operation', root).end()
    root.end()
    expect(exported.map((span) => span.name)).toEqual([
      'custom-operation',
      'next-build',
    ])
    expect(local.map((span) => span.name)).toContain('run-webpack')
  })

  it.each(['live', 'early'])(
    'preserves immediate local parent IDs across unselected %s spans',
    (mode) => {
      const root = buildRoot()
      installProvider()
      if (mode === 'live') backend.enableReporting()
      const intermediary = recorder.createLocalSpan({
        name: 'unselected-intermediary',
        parent: root,
      })
      const intermediaryId = recorder.getToolingSpanSource(intermediary)!.id
      const leaf = child('selected-leaf', intermediary)
      leaf.end()
      intermediary.end()
      if (mode === 'early') backend.enableReporting()
      root.end()

      expect(exported.map((span) => span.name)).toEqual([
        'selected-leaf',
        'next-build',
      ])
      const [exportedLeaf, exportedRoot] = exported
      const localLeaf = local.find((event) => event.name === 'selected-leaf')!
      expect(localLeaf.parentId).toBe(intermediaryId)
      expect(exportedLeaf.attributes['next.tooling.parent_id']).toBe(
        localLeaf.parentId
      )
      expect(exportedLeaf.parentSpanContext?.spanId).toBe(
        exportedRoot.spanContext().spanId
      )
    }
  )

  it.each(['live', 'early'])(
    'preserves processor names for untouched %s local spans',
    (mode) => {
      const root = buildRoot()
      installProvider((span) => {
        if (span.name === 'local-operation') {
          ;(span as ReadableSpan & Span).updateName('processor-operation')
        }
      })
      if (mode === 'live') backend.enableReporting()
      child('local-operation', root).end()
      if (mode === 'early') backend.enableReporting()
      root.end()

      expect(exported.map((span) => span.name)).toEqual([
        'processor-operation',
        'next-build',
      ])
      expect(local.map((event) => event.name)).toEqual([
        'local-operation',
        'next-build',
      ])
    }
  )

  it.each(['renamed-operation', 'local-operation'])(
    'preserves explicit local name %s when SDK start completes the span',
    (name) => {
      const root = buildRoot()
      const operation = child('local-operation', root)
      installProvider((span) => {
        if (span.name === 'local-operation') {
          ;(span as ReadableSpan & Span).updateName('processor-operation')
          operation.updateName(name)
          operation.end()
        }
      })
      backend.enableReporting()
      operation.end()
      root.end()

      expect(exported.map((span) => span.name)).toEqual([name, 'next-build'])
      expect(local.map((event) => event.name)).toEqual([name, 'next-build'])
    }
  )

  it('delegates request and live tooling mutations through the local recorder', () => {
    const originalDevServer = process.env.__NEXT_DEV_SERVER
    const registryKey = Symbol.for(
      `@next/local-span-recorder@${process.env.__NEXT_VERSION}`
    )
    const registry = globalThis as typeof globalThis & Record<symbol, unknown>
    const originalRecorder = registry[registryKey]
    const requestRecorder =
      require('../../packages/next/src/server/lib/trace/request-span-recorder') as typeof import('../../packages/next/src/server/lib/trace/request-span-recorder')
    const spanStore =
      require('../../packages/next/src/server/lib/trace/span-store') as typeof import('../../packages/next/src/server/lib/trace/span-store')
    process.env.__NEXT_DEV_SERVER = '1'
    requestRecorder.registerLocalSpanRecorder()
    spanStore.setSpanRecorderForTest(() => {})
    try {
      const startDelegate = jest.spyOn(
        recorder.LocalRecordingSpan,
        'startDelegate'
      )
      const endDelegate = jest.spyOn(recorder.LocalRecordingSpan, 'endDelegate')
      const started: ReadableSpan[] = []
      installProvider((span) => started.push(span))
      const root = buildRoot()
      backend.enableReporting()
      const tooling = child('live-tooling', root)

      const mutate = (span: Span, name: string) => {
        expect(span).toBeInstanceOf(recorder.LocalRecordingSpan)
        const delegate = started.find((entry) => entry.name === name)!
        expect(recorder.getOpenTelemetrySpan(span)).toBe(delegate)
        span.setAttribute('phase', 'running')
        span.setAttributes({ operation: name })
        span.addEvent('checkpoint', { phase: 'running' })
        span.recordException(new TypeError(`${name} failed`))
        span.setStatus({
          code: api.SpanStatusCode.ERROR,
          message: `${name} failed`,
        })
        span.updateName(`${name}-finished`)
        expect(delegate.attributes).toMatchObject({
          phase: 'running',
          operation: name,
        })
        expect(delegate.name).toBe(`${name}-finished`)
        expect(delegate.status).toEqual({
          code: api.SpanStatusCode.ERROR,
          message: `${name} failed`,
        })
        expect(delegate.events.map((event) => event.name)).toEqual([
          'checkpoint',
          'exception',
        ])
      }

      const { getTracer } =
        require('../../packages/next/src/server/lib/trace/tracer') as typeof import('../../packages/next/src/server/lib/trace/tracer')
      const { BaseServerSpan } =
        require('../../packages/next/src/server/lib/trace/constants') as typeof import('../../packages/next/src/server/lib/trace/constants')
      const request = getTracer().trace(
        BaseServerSpan.handleRequest,
        { reportToOtel: true, spanName: 'request' },
        (span) => {
          mutate(span!, 'request')
          return span!
        }
      )
      mutate(tooling, 'live-tooling')
      tooling.end()
      tooling.end()
      request.end()
      root.end()
      expect(exported.map((span) => span.name)).toEqual([
        'request-finished',
        'live-tooling-finished',
        'next-build',
      ])
      for (const span of exported.slice(0, 2)) {
        expect(span.events.map((event) => event.name)).toEqual([
          'checkpoint',
          'exception',
        ])
      }
      expect(startDelegate.mock.calls.map(([, name]) => name)).toEqual([
        'next-build',
        'live-tooling',
        'request',
      ])
      for (const [delegate] of startDelegate.mock.calls) {
        expect(endDelegate.mock.calls.map(([ended]) => ended)).toContain(
          delegate
        )
      }
    } finally {
      spanStore.setSpanRecorderForTest(undefined)
      if (originalDevServer === undefined) {
        delete process.env.__NEXT_DEV_SERVER
      } else {
        process.env.__NEXT_DEV_SERVER = originalDevServer
      }
      if (originalRecorder === undefined) {
        delete registry[registryKey]
      } else {
        registry[registryKey] = originalRecorder
      }
    }
  })

  it('replays early local span mutations with their original timestamps', () => {
    const root = buildRoot()
    const early = recorder.createLocalSpan({
      name: 'early-operation',
      parent: root,
      reportToOtel: true,
      attributes: { initial: 'captured' },
      links: [
        {
          context: {
            traceId: '0123456789abcdef0123456789abcdef',
            spanId: '0123456789abcdef',
            traceFlags: 1,
          },
          attributes: { source: 'linked-work' },
        },
      ],
    })
    const start = recorder.getToolingSpanSource(early)!.startTime
    const end = start + BigInt(123_456_789)
    const { toolingSpanTime } =
      require('../../packages/next/src/trace/trace') as typeof import('../../packages/next/src/trace/trace')
    early.setAttribute('phase', 'completed')
    early.addEvent(
      'checkpoint',
      { phase: 'completed' },
      [1_700_000_000, 123_000_000]
    )
    early.recordException(
      new TypeError('early failure'),
      [1_700_000_000, 456_000_000]
    )
    early.setStatus({
      code: api.SpanStatusCode.ERROR,
      message: 'early failure',
    })
    early.updateName('early-operation-finished')
    early.end(toolingSpanTime(end))
    early.end()

    const sampler = new sdk.AlwaysOnSampler()
    const shouldSample = jest.spyOn(sampler, 'shouldSample')
    installProvider(undefined, sampler)
    backend.enableReporting()
    root.end()

    expect(exported.map((span) => span.name)).toEqual([
      'early-operation-finished',
      'next-build',
    ])
    const [span, exportedRoot] = exported
    expect(span.parentSpanContext?.spanId).toBe(
      exportedRoot.spanContext().spanId
    )
    expect(span.startTime).toEqual(toolingSpanTime(backend.epochTime(start)))
    expect(span.endTime).toEqual(toolingSpanTime(backend.epochTime(end)))
    expect(span.attributes).toMatchObject({
      initial: 'captured',
      phase: 'completed',
    })
    expect(span.status).toEqual({
      code: api.SpanStatusCode.ERROR,
      message: 'early failure',
    })
    expect(span.events).toEqual([
      expect.objectContaining({
        name: 'checkpoint',
        time: [1_700_000_000, 123_000_000],
        attributes: { phase: 'completed' },
      }),
      expect.objectContaining({
        name: 'exception',
        time: [1_700_000_000, 456_000_000],
        attributes: expect.objectContaining({
          'exception.type': 'TypeError',
          'exception.message': 'early failure',
        }),
      }),
    ])
    expect(span.links).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          traceId: '0123456789abcdef0123456789abcdef',
          spanId: '0123456789abcdef',
        }),
        attributes: { source: 'linked-work' },
      }),
    ])
    expect(shouldSample).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      'early-operation-finished',
      expect.any(Number),
      expect.objectContaining({ initial: 'captured', phase: 'completed' }),
      expect.any(Array)
    )
  })

  it('detaches early span and completed observation data without custom serializers', () => {
    const serialize = jest.fn(() => {
      throw new Error('custom serializer called')
    })
    const attributeValues = Object.assign(['attribute-before'], {
      toJSON: serialize,
    })
    const linkValues = Object.assign(['link-before'], { toJSON: serialize })
    const eventValues = Object.assign(['event-before'], { toJSON: serialize })
    const workerValues = Object.assign(['worker-before'], { toJSON: serialize })
    const observationValues = Object.assign(['observation-before'], {
      toJSON: serialize,
    })
    const link = {
      context: {
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: '0123456789abcdef',
        traceFlags: 1,
      },
      attributes: { values: linkValues },
    }
    const root = buildRoot()
    const operation = recorder.createLocalSpan({
      name: 'early-copy',
      parent: root,
      reportToOtel: true,
      links: [link],
    })
    link.context.spanId = 'fedcba9876543210'
    linkValues[0] = 'link-after'
    operation.setAttribute('values', attributeValues)
    operation.addEvent('checkpoint', { values: eventValues })
    operation.end()
    attributeValues[0] = 'attribute-after'
    eventValues[0] = 'event-after'

    const { recordTraceEvents } =
      require('../../packages/next/src/trace/trace') as typeof import('../../packages/next/src/trace/trace')
    const rootId = recorder.getToolingSpanSource(root)!.id
    recordTraceEvents(
      [
        {
          id: 100,
          parentId: rootId,
          name: 'worker-copy',
          timestamp: 1,
          duration: 1,
          tags: { values: workerValues },
        },
      ],
      [{ id: 100, parentId: rootId }]
    )
    workerValues[0] = 'worker-after'
    const { recordSpans } =
      require('../../packages/next/src/server/lib/trace/span-store') as typeof import('../../packages/next/src/server/lib/trace/span-store')
    recordSpans(
      [
        {
          name: 'observation-copy',
          reportToOtel: true,
          attributes: { values: observationValues },
        },
      ],
      'tooling',
      root
    )
    observationValues[0] = 'observation-after'
    installProvider()
    backend.enableReporting()
    root.end()

    expect(exported.map((span) => span.name)).toEqual([
      'early-copy',
      'worker-copy',
      'observation-copy',
      'next-build',
    ])
    expect(exported[0].attributes.values).toBe('["attribute-before"]')
    expect(exported[0].links[0]).toMatchObject({
      context: { spanId: '0123456789abcdef' },
      attributes: { values: ['link-before'] },
    })
    expect(exported[0].events[0]).toMatchObject({
      name: 'checkpoint',
      attributes: { values: ['event-before'] },
    })
    expect(exported[1].attributes.values).toBe('["worker-before"]')
    expect(exported[2].attributes.values).toBe('["observation-before"]')
    expect(serialize).not.toHaveBeenCalled()
  })

  it('drains a completion when an attribute getter enables reporting', () => {
    const root = buildRoot()
    const operation = child('getter-ready-operation', root)
    const readValue = jest.fn(() => {
      backend.enableReporting()
      return 'captured'
    })
    operation.setAttribute(
      'values',
      Object.defineProperty(['captured'], '0', { get: readValue })
    )
    installProvider()

    operation.end()

    expect(readValue).toHaveBeenCalled()
    expect(exported.map((span) => span.name)).toEqual([
      'getter-ready-operation',
    ])
    expect(exported[0].attributes.values).toBe('["captured"]')
    expect(local.map((event) => event.name)).toEqual(['getter-ready-operation'])

    root.end()
    expect(exported.map((span) => span.name)).toEqual([
      'getter-ready-operation',
      'next-build',
    ])
  })

  it('preserves mixed span events across SDK registration and the final name', () => {
    const root = buildRoot()
    const operation = child('mixed-operation', root)
    operation.addEvent('before-registration', { order: 1 })
    operation.recordException(new TypeError('before failure'))
    installProvider()
    backend.enableReporting()
    operation.addEvent('after-registration', { order: 3 })
    operation.recordException(new RangeError('after failure'))
    operation.addEvent('after-error', { order: 5 })
    operation.updateName('mixed-operation-finished')
    operation.end()
    root.end()

    expect(exported.map((span) => span.name)).toEqual([
      'mixed-operation-finished',
      'next-build',
    ])
    expect(exported[0].events).toEqual([
      expect.objectContaining({
        name: 'before-registration',
        attributes: { order: 1 },
      }),
      expect.objectContaining({
        name: 'exception',
        attributes: expect.objectContaining({
          'exception.type': 'TypeError',
          'exception.message': 'before failure',
        }),
      }),
      expect.objectContaining({
        name: 'after-registration',
        attributes: { order: 3 },
      }),
      expect.objectContaining({
        name: 'exception',
        attributes: expect.objectContaining({
          'exception.type': 'RangeError',
          'exception.message': 'after failure',
        }),
      }),
      expect.objectContaining({
        name: 'after-error',
        attributes: { order: 5 },
      }),
    ])
    expect(
      local.find((event) => event.name === 'mixed-operation-finished')
    ).toBeDefined()
  })

  it('delegates worker replay and completed observations through the same recorder', () => {
    const startDelegate = jest.spyOn(
      recorder.LocalRecordingSpan,
      'startDelegate'
    )
    const endDelegate = jest.spyOn(recorder.LocalRecordingSpan, 'endDelegate')
    const { recordTraceEvents } =
      require('../../packages/next/src/trace/trace') as typeof import('../../packages/next/src/trace/trace')
    const { recordSpans } =
      require('../../packages/next/src/server/lib/trace/span-store') as typeof import('../../packages/next/src/server/lib/trace/span-store')
    const root = buildRoot()
    const rootId = recorder.getToolingSpanSource(root)!.id
    installProvider()
    backend.enableReporting()
    const workerStart = process.hrtime.bigint() - BigInt(2_000_000)
    recordTraceEvents(
      [
        {
          id: 100,
          parentId: rootId,
          name: 'worker-operation',
          timestamp: Number(workerStart / BigInt(1000)),
          duration: 1000,
          startTime: Date.now() - 2,
          tags: { phase: 'worker-completed' },
        },
      ],
      [{ id: 100, parentId: rootId }]
    )
    const epoch = BigInt(Date.now()) * BigInt(1_000_000)
    recordSpans(
      [
        {
          name: 'completed-observation',
          startTime: epoch - BigInt(15_000_000),
          endTime: epoch,
          reportToOtel: true,
          attributes: { phase: 'observation-completed' },
        },
      ],
      'tooling',
      root
    )
    root.end()

    expect(startDelegate.mock.calls.map(([, name]) => name)).toEqual([
      'next-build',
      'worker-operation',
      'completed-observation',
    ])
    for (const [delegate] of startDelegate.mock.calls) {
      expect(endDelegate.mock.calls.map(([ended]) => ended)).toContain(delegate)
    }
    expect(exported.map((span) => span.name)).toEqual([
      'worker-operation',
      'completed-observation',
      'next-build',
    ])
    const [worker, observation, exportedRoot] = exported
    for (const span of [worker, observation]) {
      expect(span.parentSpanContext?.spanId).toBe(
        exportedRoot.spanContext().spanId
      )
    }
    expect(worker.attributes).toMatchObject({ phase: 'worker-completed' })
    expect(worker.duration).toEqual([0, 1_000_000])
    expect(observation.attributes).toMatchObject({
      phase: 'observation-completed',
    })
    expect(observation.duration).toEqual([0, 15_000_000])
    expect(
      local.filter((event) => event.name === 'completed-observation')
    ).toHaveLength(1)
  })

  it('retains at most 1000 spans without losing local records or the root', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    for (let i = 0; i < 1000; i++) child('ordinary').end()
    // The root has a dedicated slot even when ordinary replay is full.
    const root = buildRoot()
    root.setAttribute('payload', 'x'.repeat(1024))
    root.end()
    expect(local).toHaveLength(1001)
    installProvider()
    backend.enableReporting()
    backend.closeReporting()
    expect(exported).toHaveLength(1000)
    expect(
      exported.find((span) => span.name === 'next-build')?.attributes.payload
    ).toHaveLength(1024)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it.each(['live', 'early'])(
    'reports large %s payloads without replay serialization or byte limits',
    (mode) => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const serialize = jest.fn(() => ['linked-value'])
      const values = Object.assign(['linked-value'], { toJSON: serialize })
      const payload = 'x'.repeat(8 * 1024 * 1024)
      const root = buildRoot()
      installProvider()
      if (mode === 'live') backend.enableReporting()

      const operation = recorder.createLocalSpan({
        name: 'ready-operation',
        parent: root,
        reportToOtel: true,
        links: [
          {
            context: {
              traceId: '0123456789abcdef0123456789abcdef',
              spanId: '0123456789abcdef',
              traceFlags: 1,
            },
            attributes: { values },
          },
        ],
      })
      operation.setAttribute('payload', payload)
      operation.end()
      if (mode === 'early') backend.enableReporting()
      root.end()

      expect(exported.map((span) => span.name)).toEqual([
        'ready-operation',
        'next-build',
      ])
      expect(exported[0].attributes.payload).toBe(payload)
      expect(exported[0].links[0].attributes?.values).toEqual(['linked-value'])
      expect(serialize).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
      expect(
        local.find((event) => event.name === 'ready-operation')?.tags?.payload
      ).toHaveLength(payload.length)
    }
  )

  it.each(['explicit', 'getter'])(
    'keeps %s failure when an attribute getter prevents copying',
    (failure) => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const root = buildRoot()
      const operation = child('clone-error', root)
      if (failure === 'explicit') {
        operation.setStatus({ code: api.SpanStatusCode.ERROR })
      }
      operation.setAttribute(
        'payload',
        Object.defineProperty([''], '0', {
          get() {
            if (failure === 'getter') operation.setAttribute('failed', true)
            throw new Error('attribute getter failed')
          },
        })
      )
      operation.end()
      child('after-clone-error', root).end()
      installProvider()
      backend.enableReporting()
      root.end()

      expect(exported.map((span) => span.name)).toEqual([
        'clone-error',
        'after-clone-error',
        'next-build',
      ])
      expect(exported[0].status.code).toBe(api.SpanStatusCode.ERROR)
      expect(exported[0].attributes.payload).toBeUndefined()
      expect(
        local.find((event) => event.name === 'clone-error')?.tags?.payload
      ).toBeInstanceOf(Array)
      if (failure === 'getter') {
        expect(
          local.find((event) => event.name === 'clone-error')?.tags?.failed
        ).toBe(true)
      }
      expect(warn).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['close', 'reset'])(
    'rejects stale replay admission when a link attribute getter triggers %s',
    (action) => {
      const root = buildRoot()
      installProvider()
      const readValue = jest.fn(() => {
        if (action === 'close') backend.closeReporting()
        else {
          const replacement = buildRoot('replacement-root')
          backend.enableReporting()
          child('replacement-child', replacement).end()
          replacement.end()
        }
        return 'linked-value'
      })
      const values = Object.defineProperty(['linked-value'], '0', {
        get: readValue,
      })
      recorder
        .createLocalSpan({
          name: 'getter-operation',
          parent: root,
          reportToOtel: true,
          links: [
            {
              context: {
                traceId: '0123456789abcdef0123456789abcdef',
                spanId: '0123456789abcdef',
                traceFlags: 1,
              },
              attributes: { values },
            },
          ],
        })
        .end()
      backend.enableReporting()
      root.end()

      expect(readValue).toHaveBeenCalled()
      expect(exported.map((span) => span.name)).toEqual(
        action === 'close' ? [] : ['replacement-child', 'replacement-root']
      )
      expect(local.map((event) => event.name)).toEqual(
        expect.arrayContaining(['getter-operation', 'next-build'])
      )
    }
  )

  it('keeps local diagnostics when application SDK callbacks throw', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    installProvider(() => {
      throw new Error('application processor failure')
    })
    const root = buildRoot()
    backend.enableReporting()
    expect(() => child('child', root).end()).not.toThrow()
    expect(() => root.end()).not.toThrow()
    backend.closeReporting()
    expect(local.map((span) => span.name)).toEqual(['child', 'next-build'])
    expect(exported).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('finishes reentrant SDK work without recursive entry or duplicate completion', () => {
    const root = buildRoot()
    let inside = false
    let recursive = false
    const starts = jest.fn(() => {
      recursive ||= inside
      inside = true
      if (starts.mock.calls.length === 1) {
        root.end()
        child('child', root).end()
      }
      inside = false
    })
    installProvider(starts)
    backend.enableReporting()
    expect(recursive).toBe(false)
    expect(starts).toHaveBeenCalledTimes(2)
    expect(local.map((span) => span.name)).toEqual(['next-build', 'child'])
    expect(exported.map((span) => span.name)).toEqual(['next-build', 'child'])
    expect(exported[1].parentSpanContext?.spanId).toBe(
      exported[0].spanContext().spanId
    )
  })

  it.each(['close', 'reset'])(
    'stops old SDK work after a callback %s',
    (action) => {
      const root = buildRoot()
      installProvider((span) => {
        if (span.name !== 'next-build') return
        if (action === 'close') backend.closeReporting()
        else {
          const replacement = buildRoot('replacement-root')
          backend.enableReporting()
          child('replacement-child', replacement).end()
          replacement.end()
        }
      })
      backend.enableReporting()
      root.end()
      expect(exported.map((span) => span.name).sort()).toEqual(
        action === 'close' ? [] : ['replacement-child', 'replacement-root']
      )
      expect(local.some((span) => span.name === 'next-build')).toBe(true)
    }
  )

  it('retains out-of-order worker results without replacing a live coordinator parent', () => {
    const { recordTraceEvents } = require('../../packages/next/src/trace/trace')
    const {
      getToolingSpanSource,
    } = require('../../packages/next/src/server/lib/trace/local-span-recorder')
    const root = buildRoot()
    const parent = child('live-coordinator', root)
    const parentId = getToolingSpanSource(parent).id
    const rootId = getToolingSpanSource(root).id
    installProvider()
    backend.enableReporting()
    // Parallel workers inherit snapshots of the coordinator counter. Their
    // completion order and overlapping IDs must not filter distinct results.
    for (const id of [100, parentId]) {
      recordTraceEvents(
        [
          {
            id,
            parentId: rootId,
            name: `worker-${id}`,
            timestamp: 1,
            duration: 1,
          },
        ],
        [{ id, parentId: rootId }]
      )
    }
    expect(local.map((event) => event.name)).toEqual([
      'worker-100',
      `worker-${parentId}`,
    ])
    child('numeric-child', parentId).end()
    parent.end()
    root.end()
    expect(exported.map((span) => span.name)).toEqual([
      'worker-100',
      `worker-${parentId}`,
      'numeric-child',
      'live-coordinator',
      'next-build',
    ])
    expect(exported[2].parentSpanContext?.spanId).toBe(
      exported[3].spanContext().spanId
    )
  })

  it('parents worker children to the root when their parent SDK callback fails', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const { recordTraceEvents } =
      require('../../packages/next/src/trace/trace') as typeof import('../../packages/next/src/trace/trace')
    const root = buildRoot()
    const rootId = recorder.getToolingSpanSource(root)!.id
    const parentName = 'worker-parent'

    recordTraceEvents(
      [
        {
          id: 101,
          parentId: 100,
          name: 'worker-child',
          timestamp: 2,
          duration: 1,
        },
        {
          id: 100,
          parentId: rootId,
          name: parentName,
          timestamp: 1,
          duration: 3,
        },
      ],
      [
        { id: 101, parentId: 100 },
        { id: 100, parentId: rootId },
      ]
    )
    installProvider((span) => {
      if (span.name === parentName) throw new Error('parent processor failed')
    })
    backend.enableReporting()
    root.end()

    expect(exported.map((span) => span.name)).toEqual([
      'worker-child',
      'next-build',
    ])
    expect(exported[0].parentSpanContext?.spanId).toBe(
      exported[1].spanContext().spanId
    )
    expect(exported[0].attributes['next.tooling.parent_id']).toBe(100)
    expect(local).toHaveLength(3)
    expect(local.some((event) => event.name === parentName)).toBe(true)
    expect(local.some((event) => event.name === 'worker-child')).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it.each(['on', 'off'])(
    'leaves recorded metrics available after close with trace sampling %s',
    async (sampling) => {
      const {
        MeterProvider,
        InMemoryMetricExporter,
        PeriodicExportingMetricReader,
        AggregationTemporality,
      } = require('@opentelemetry/sdk-metrics')
      const exporter = new InMemoryMetricExporter(
        AggregationTemporality.CUMULATIVE
      )
      const provider = new MeterProvider({
        readers: [
          new PeriodicExportingMetricReader({
            exporter,
            exportIntervalMillis: 60000,
          }),
        ],
      })
      expect(api.metrics.setGlobalMeterProvider(provider)).toBe(true)
      try {
        buildRoot()
        const {
          createLocalSpan,
        } = require('../../packages/next/src/server/lib/trace/local-span-recorder')
        const native = createLocalSpan({
          name: 'turbopack-persistence',
          reportToOtel: true,
          attributes: { bytes_written: 1 },
        })
        const sampler =
          sampling === 'on'
            ? new sdk.AlwaysOnSampler()
            : new sdk.AlwaysOffSampler()
        const shouldSample = jest.spyOn(sampler, 'shouldSample')
        installProvider((span) => {
          if (span.name === 'turbopack-persistence') native.end()
        }, sampler)
        backend.enableReporting()
        native.end()
        createLocalSpan({
          name: 'turbopack-persistence',
          reportToOtel: true,
          attributes: { bytes_written: 2 },
        }).end()
        require('../../packages/next/src/server/lib/trace/span-store').recordSpans(
          [
            {
              name: 'turbopack-persistence',
              reportToOtel: true,
              attributes: { bytes_written: 4 },
            },
          ],
          'tooling',
          undefined
        )
        createLocalSpan({
          name: 'server-restart-close-to-memory-threshold',
          reportToOtel: true,
          attributes: { 'memory.heapUsed': 100, 'memory.heapSizeLimit': 200 },
        }).end()
        backend.closeReporting()
        await provider.forceFlush()
        const expectedMetrics = [
          expect.objectContaining({
            descriptor: expect.objectContaining({
              name: 'next.tooling.turbopack.bytes_written',
            }),
            dataPoints: [
              expect.objectContaining({
                attributes: { operation: 'turbopack-persistence' },
                value: expect.objectContaining({ count: 3, sum: 7 }),
              }),
            ],
          }),
          expect.objectContaining({
            descriptor: expect.objectContaining({
              name: 'next.tooling.server.restarts',
            }),
            dataPoints: [
              expect.objectContaining({
                attributes: { reason: 'memory-threshold' },
                value: 1,
              }),
            ],
          }),
        ]
        for (const [name, value] of [
          ['heap_used', 100],
          ['heap_limit', 200],
        ] as const) {
          expectedMetrics.push(
            expect.objectContaining({
              descriptor: expect.objectContaining({
                name: `next.tooling.memory.${name}`,
              }),
              dataPoints: [
                expect.objectContaining({
                  attributes: {
                    operation: 'server-restart-close-to-memory-threshold',
                  },
                  value: expect.objectContaining({ count: 1, sum: value }),
                }),
              ],
            })
          )
        }
        expect(exporter.getMetrics()).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              scopeMetrics: expect.arrayContaining([
                expect.objectContaining({
                  metrics: expect.arrayContaining(expectedMetrics),
                }),
              ]),
            }),
          ])
        )
        expect(shouldSample).toHaveBeenCalledWith(
          expect.anything(),
          expect.any(String),
          'turbopack-persistence',
          expect.any(Number),
          expect.objectContaining({ bytes_written: 4 }),
          expect.any(Array)
        )
        if (sampling === 'off') expect(exported).toEqual([])
      } finally {
        await provider.shutdown()
      }
    }
  )

  it('keeps root metric context for parentless operations', () => {
    const record = jest.fn()
    const add = jest.fn()
    expect(
      api.metrics.setGlobalMeterProvider({
        getMeter: () => ({
          createHistogram: () => ({ record }),
          createCounter: () => ({ add }),
        }),
      } as unknown as import('@opentelemetry/api').MeterProvider)
    ).toBe(true)
    const started: ReadableSpan[] = []
    installProvider((span) => started.push(span))
    const root = buildRoot()
    backend.enableReporting()

    recorder
      .createLocalSpan({
        name: 'memory-usage',
        parent: null,
        reportToOtel: true,
        attributes: { 'memory.rss': 100 },
      })
      .end()
    recorder
      .createLocalSpan({
        name: 'server-restart-close-to-memory-threshold',
        parent: null,
        reportToOtel: true,
        attributes: { 'memory.heapUsed': 50 },
      })
      .end()
    recorder
      .createLocalSpan({
        name: 'parentless-operation',
        parent: null,
        reportToOtel: true,
      })
      .end()
    root.end()

    expect(record).toHaveBeenCalledTimes(2)
    expect(add).toHaveBeenCalledTimes(1)
    const rootContext = started[0].spanContext()
    for (const [, , context] of [...record.mock.calls, ...add.mock.calls]) {
      expect(api.trace.getSpanContext(context)).toEqual(rootContext)
    }
    expect(exported.map((span) => span.name)).toEqual([
      'parentless-operation',
      'next-build',
    ])
    expect(exported[0].parentSpanContext).toBeUndefined()
    expect(exported[0].spanContext().traceId).not.toBe(rootContext.traceId)
  })

  it('records metrics with a late meter provider and no trace provider', async () => {
    backend.enableReporting()
    recorder
      .createLocalSpan({
        name: 'turbopack-persistence',
        reportToOtel: true,
        attributes: { bytes_written: 1 },
      })
      .end()

    const {
      MeterProvider,
      InMemoryMetricExporter,
      PeriodicExportingMetricReader,
      AggregationTemporality,
    } = require('@opentelemetry/sdk-metrics')
    const exporter = new InMemoryMetricExporter(
      AggregationTemporality.CUMULATIVE
    )
    const provider = new MeterProvider({
      readers: [
        new PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: 60000,
        }),
      ],
    })
    expect(api.metrics.setGlobalMeterProvider(provider)).toBe(true)
    try {
      recorder
        .createLocalSpan({
          name: 'turbopack-persistence',
          reportToOtel: true,
          attributes: { bytes_written: 2 },
        })
        .end()
      backend.closeReporting()
      await provider.forceFlush()

      expect(exporter.getMetrics()).toEqual([
        expect.objectContaining({
          scopeMetrics: [
            expect.objectContaining({
              metrics: [
                expect.objectContaining({
                  descriptor: expect.objectContaining({
                    name: 'next.tooling.turbopack.bytes_written',
                  }),
                  dataPoints: [
                    expect.objectContaining({
                      attributes: { operation: 'turbopack-persistence' },
                      value: expect.objectContaining({ count: 1, sum: 2 }),
                    }),
                  ],
                }),
              ],
            }),
          ],
        }),
      ])
      expect(exported).toEqual([])
      expect(local.map((event) => event.name)).toEqual([
        'turbopack-persistence',
        'turbopack-persistence',
      ])
    } finally {
      await provider.shutdown()
    }
  })

  it('closes reporting without ending unfinished operations or accepting new ones', () => {
    installProvider()
    const root = buildRoot()
    backend.enableReporting()
    child('completed', root).end()
    backend.closeReporting()
    backend.closeReporting()
    child('after-close', root).end()
    root.end()
    expect(exported.map((span) => span.name)).toEqual(['completed'])
    expect(local.map((event) => event.name)).toEqual([
      'completed',
      'after-close',
      'next-build',
    ])
  })
})
