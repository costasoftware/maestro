import type { TelemetryEvent, TelemetrySink } from '@maestro/core'

/**
 * Console-backed telemetry sink — one line per event. Useful for
 * watching the kernel fire `turn.finalized`, `quota.consumed`,
 * `turn.empty_recovery`, etc. against the dev server log.
 *
 * Production hosts route to maestro-plane / Sentry / OTel / Datadog.
 * The kernel guarantees emit is fire-and-forget — emit failures are
 * swallowed inside the sink, so a flaky pipeline never blocks the
 * stream finalisation.
 */
export class ConsoleTelemetrySink implements TelemetrySink {
    async emit(events: TelemetryEvent[]): Promise<void> {
        for (const ev of events) {
            // Cheap structured log. Real sinks batch + retry; this just
            // surfaces the shape so demos can see the events flowing.
            const { type, occurredAt: _occurredAt, ...rest } = ev
            console.info(`[telemetry] ${type}`, rest)
        }
    }
}
