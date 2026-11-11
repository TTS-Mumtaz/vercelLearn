import { traceLocalSpan } from '../../server/lib/trace/local-span-recorder'
import { NextBuildContext } from '../build-context'
import { ToolingSpan } from '../../server/lib/trace/constants'
import type { Telemetry } from '../../telemetry/storage'
import { turbopackBuild as turbopackBuildImpl } from './impl'

export function turbopackBuild(
  telemetry: Telemetry
): ReturnType<typeof turbopackBuildImpl> {
  const nextBuildSpan = NextBuildContext.nextBuildSpan!
  return traceLocalSpan(
    {
      name: ToolingSpan.runTurbopack,
      reportToOtel: true,
      recordToInsights: true,
      scope: true,
      parent: nextBuildSpan,
    },
    () => turbopackBuildImpl(telemetry)
  )
}
