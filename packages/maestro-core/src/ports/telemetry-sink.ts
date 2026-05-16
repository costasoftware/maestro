import type { QuotaWindow } from './quota-store.js'

/**
 * Best-effort observability events. Kernel emits these as a batched
 * fire-and-forget stream. Hosts ship to: maestro-plane, Sentry, OTel,
 * Datadog, or a no-op for self-hosted-only setups.
 *
 * Contract: emit MUST eventually settle (resolve or reject). The
 * kernel will not block a chat turn on this — slow emits just back up
 * the in-memory queue and eventually drop after retries.
 */
export type TelemetryEvent =
    | {
          type: 'turn.finalized'
          turnId: string
          threadId: string
          tenantId: string
          modelId: string
          tier: 'fast' | 'smart'
          tokensIn: number
          tokensOut: number
          cacheReadTokens: number
          cacheWriteTokens: number
          /** USD cost in micro-dollars (integer). */
          costUsdMicro: number
          durationMs: number
          occurredAt: Date
      }
    | {
          type: 'tool.called'
          toolName: string
          tenantId: string
          transport: string
          actor: string
          durationMs: number
          ok: boolean
          errorCode?: string
          occurredAt: Date
      }
    | {
          type: 'quota.consumed'
          tenantId: string
          surface: string
          window: QuotaWindow
          used: number
          ceiling: number
          denied: boolean
          occurredAt: Date
      }
    | {
          type: 'model.failover'
          tenantId: string
          from: string
          to: string
          reason: string
          occurredAt: Date
      }
    | {
          type: 'empty.recovery'
          tenantId: string
          surface: string
          mode: string
          occurredAt: Date
      }

export interface TelemetrySink {
    /** Batched async send. Implementations should handle batching + retries internally. */
    emit(events: TelemetryEvent[]): Promise<void>
}

/**
 * Default sink — drops everything. Used when the host doesn't want
 * telemetry (single-tenant deploy, dev environment, before maestro-plane
 * exists). Kernel always works with this wired.
 */
export class NoopTelemetrySink implements TelemetrySink {
    async emit(): Promise<void> {
        // Intentionally empty.
    }
}
