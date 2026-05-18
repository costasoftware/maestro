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
    | {
          /**
           * Emitted by `runChatTurn` whenever the empty-recovery
           * classifier engages on a finished turn (`decision.triggered === true`).
           * The not-triggered path is intentionally NOT emitted — operators
           * dashboard stalled rates, not the steady-state pass.
           *
           * When `decision.mode === 'enforce'` AND the host supplied a
           * `writer` arg to `runChatTurn`, the kernel performs mid-stream
           * synthesis injection (second `streamText` call merged into
           * the same UI stream). When `enforce` is requested but no
           * writer is supplied, the kernel additionally emits
           * `turn.empty_recovery_skipped` to flag the degraded path.
           *
           * The `decision` field carries the full `EmptyRecoveryDecision`
           * struct returned by the `decideEmptyRecovery` helper. Inlined
           * here as a structural shape so the ports layer stays free of
           * runtime/* imports.
           */
          type: 'turn.empty_recovery'
          turnId: string
          threadId: string
          tenantId: string
          decision: {
              triggered: boolean
              mode: 'off' | 'log_only' | 'enforce'
              fallbackText: string | null
              persistedErrorCode: string | null
          }
          occurredAt: Date
      }
    | {
          /**
           * Emitted by `runChatTurn` whenever empty-recovery `enforce`
           * mode is requested AND triggers AND would have injected a
           * synthesis stream, but the kernel could not actually perform
           * the injection (no `writer` arg supplied, today the only
           * documented reason). Sibling to `turn.empty_recovery` —
           * surfaces the degraded path so operators can dashboard hosts
           * that asked for enforce but never wired the writer.
           *
           * `reason` is open-ended so future skip causes (mid-stream
           * abort, second-call provider error) can be reported with a
           * stable enum without re-shaping the event.
           */
          type: 'turn.empty_recovery_skipped'
          turnId: string
          threadId: string
          tenantId: string
          reason: 'no_writer' | string
          requestedMode: 'enforce'
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
