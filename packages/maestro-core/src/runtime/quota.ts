import type { QuotaState, QuotaStore } from '../ports/quota-store.js'

/**
 * Why this reason set: each value names the COUNTER that tripped,
 * not the window or unit. Hosts compose their own UI-facing
 * `tokens_per_day` / `cost_per_hour` strings from `reason + window`
 * at render time. Keeping the kernel reason terse lets hosts use
 * any window granularity (daily, hourly, monthly) without the
 * kernel knowing about it.
 */
export type AiQuotaDenyReason =
    | 'input_tokens'
    | 'output_tokens'
    | 'tool_calls'
    | 'cost_usd_micro'

export interface AiQuotaDenyPayload {
    reason: AiQuotaDenyReason
    /** Ceiling that was tripped, in the natural unit of `reason` (tokens, calls, micro-USD). */
    ceiling: number
    /** Counter value at check time. May exceed `ceiling` due to race windows + post-call increments. */
    current: number
    /** When the current window resets. Surface on the deny UX. */
    windowEnd: Date
    tenantId: string
    surface: string
}

/**
 * Thrown by `runChatTurn` when the pre-call quota check finds a
 * counter at or above its ceiling. Hosts catch this at the route
 * boundary and translate to whatever HTTP error shape their client
 * renders (e.g. barbeiro's `buildQuotaDenyPayload` → 429 with
 * localized copy).
 *
 * Captured as a class (not a discriminated union) so `instanceof`
 * works across module boundaries and frame-level `instanceof` checks
 * survive bundler transforms. `payload` carries the structured data.
 */
export class AiQuotaDeniedError extends Error {
    override readonly name = 'AiQuotaDeniedError'
    readonly payload: AiQuotaDenyPayload

    constructor(payload: AiQuotaDenyPayload) {
        super(
            `AI quota exceeded: ${payload.reason} on ${payload.surface} for tenant ${payload.tenantId} (${payload.current}/${payload.ceiling})`
        )
        this.payload = payload
        // Restore the prototype chain across bundler transforms.
        Object.setPrototypeOf(this, AiQuotaDeniedError.prototype)
    }
}

/**
 * Inspect a `QuotaState` and throw on the first counter that has
 * reached or exceeded its ceiling. Order of evaluation is fixed —
 * `input_tokens` → `output_tokens` → `tool_calls` → `cost_usd_micro` —
 * so the deny reason rendered to the user is stable across deploys.
 *
 * A `null`/undefined ceiling means "unbounded" and is skipped (the
 * tenant has no cap on that counter). Counters with zero ceiling are
 * treated the same as unbounded — a zero cap is almost always a
 * misseed; failing every call would surface the bug as user pain
 * instead of a dashboard alert.
 */
export function enforceQuotaOrThrow(args: {
    tenantId: string
    surface: string
    state: QuotaState
}): void {
    const { ceilings, used, windowEnd } = args.state

    if (
        typeof ceilings.maxTokensIn === 'number' &&
        ceilings.maxTokensIn > 0 &&
        used.tokensIn >= ceilings.maxTokensIn
    ) {
        throw new AiQuotaDeniedError({
            reason: 'input_tokens',
            ceiling: ceilings.maxTokensIn,
            current: used.tokensIn,
            windowEnd,
            tenantId: args.tenantId,
            surface: args.surface,
        })
    }
    if (
        typeof ceilings.maxTokensOut === 'number' &&
        ceilings.maxTokensOut > 0 &&
        used.tokensOut >= ceilings.maxTokensOut
    ) {
        throw new AiQuotaDeniedError({
            reason: 'output_tokens',
            ceiling: ceilings.maxTokensOut,
            current: used.tokensOut,
            windowEnd,
            tenantId: args.tenantId,
            surface: args.surface,
        })
    }
    if (
        typeof ceilings.maxCallsPerWindow === 'number' &&
        ceilings.maxCallsPerWindow > 0 &&
        used.calls >= ceilings.maxCallsPerWindow
    ) {
        throw new AiQuotaDeniedError({
            reason: 'tool_calls',
            ceiling: ceilings.maxCallsPerWindow,
            current: used.calls,
            windowEnd,
            tenantId: args.tenantId,
            surface: args.surface,
        })
    }
    if (
        typeof ceilings.maxUsdMicro === 'number' &&
        ceilings.maxUsdMicro > 0 &&
        used.usdMicro >= ceilings.maxUsdMicro
    ) {
        throw new AiQuotaDeniedError({
            reason: 'cost_usd_micro',
            ceiling: ceilings.maxUsdMicro,
            current: used.usdMicro,
            windowEnd,
            tenantId: args.tenantId,
            surface: args.surface,
        })
    }
}

/**
 * Convenience: query the port and enforce in one call. The pre-call
 * check inside `runChatTurn` uses this. Fail-open behaviour (swallow
 * port errors and proceed) is the CALLER's choice — `runChatTurn`
 * decides via its `failOpenOnQuotaError` flag.
 */
export async function checkAndEnforce(args: {
    quotaStore: QuotaStore
    tenantId: string
    surface: string
}): Promise<void> {
    const state = await args.quotaStore.check({
        tenantId: args.tenantId,
        surface: args.surface,
    })
    enforceQuotaOrThrow({
        tenantId: args.tenantId,
        surface: args.surface,
        state,
    })
}
