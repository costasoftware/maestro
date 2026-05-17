/**
 * Per-tenant rate-limit and cost ceiling enforcement.
 *
 * Boundary of responsibility:
 *   - Kernel owns the WINDOW ARITHMETIC (sliding window math, day
 *     rollover, soft-cap warnings, `AiQuotaDeniedError`).
 *   - Host owns the CEILING DERIVATION (plan-tier → numbers). Kernel
 *     does not know what a "plan" is.
 *
 * `getCeilings` is called on every turn — keep it cheap (cache inside
 * the host impl). `check` returns current consumption; `record`
 * appends to the ledger (or telemetry) post-call.
 */
export type QuotaWindow = 'min' | 'hour' | 'day' | 'month'

export interface Ceilings {
    /** Max input tokens per window. Undefined = unbounded. */
    maxTokensIn?: number
    /** Max output tokens per window. Undefined = unbounded. */
    maxTokensOut?: number
    /** Max LLM calls per window. Undefined = unbounded. */
    maxCallsPerWindow?: number
    /** Max spend per window, in USD micro-dollars (integer). Undefined = unbounded. */
    maxUsdMicro?: number
}

export interface QuotaState {
    ceilings: Ceilings
    used: {
        tokensIn: number
        tokensOut: number
        calls: number
        usdMicro: number
    }
    windowStart: Date
    windowEnd: Date
}

export interface QuotaUsage {
    tenantId: string
    surface: string
    tokensIn: number
    tokensOut: number
    cacheReadTokens: number
    cacheWriteTokens: number
    /** Tool invocations attributed to this turn. Drives the `maxCallsPerWindow` ceiling. */
    toolCalls?: number
    /** USD cost in micro-dollars (integer). */
    costUsdMicro: number
    modelId: string
    occurredAt: Date
}

export interface QuotaStore {
    /** Plan-derived ceilings for the requested surface + window. */
    getCeilings(query: {
        tenantId: string
        surface: string
        window: QuotaWindow
    }): Promise<Ceilings>

    /** Current consumption against ceilings for the current window. */
    check(query: { tenantId: string; surface: string }): Promise<QuotaState>

    /** Append-only ledger write, called post-LLM-call. */
    record(usage: QuotaUsage): Promise<void>
}
