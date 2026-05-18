import type { Ceilings, QuotaState, QuotaStore, QuotaUsage } from '@costasoftware/maestro-core'

/**
 * Per-tenant call counter with a generous fixed ceiling. Demonstrates
 * the simplest legitimate quota port that still enforces something —
 * unlike `minimal-product` which uses `UnlimitedQuotaStore` and never
 * denies. Both shapes are valid; pick based on whether your product
 * needs to gate cost.
 *
 * Real products plug Redis (sliding-window counters) or Postgres
 * (append-only ledger). The kernel only needs the three methods on
 * `QuotaStore`; everything else (window arithmetic, plan tier → number
 * mapping, rollover) is the host's call.
 */
const DEFAULT_DAILY_CALL_CEILING = 500

export class InMemoryQuotaStore implements QuotaStore {
    private readonly callsByTenant = new Map<string, number>()
    private readonly tokensByTenant = new Map<string, { in: number; out: number }>()
    private readonly ceiling: number

    constructor(ceiling: number = DEFAULT_DAILY_CALL_CEILING) {
        this.ceiling = ceiling
    }

    async getCeilings(): Promise<Ceilings> {
        return { maxCallsPerWindow: this.ceiling }
    }

    async check(query: { tenantId: string }): Promise<QuotaState> {
        const calls = this.callsByTenant.get(query.tenantId) ?? 0
        const tokens = this.tokensByTenant.get(query.tenantId) ?? { in: 0, out: 0 }
        return {
            ceilings: { maxCallsPerWindow: this.ceiling },
            used: { tokensIn: tokens.in, tokensOut: tokens.out, calls, usdMicro: 0 },
            windowStart: new Date(0),
            windowEnd: new Date(8_640_000_000_000),
        }
    }

    async record(usage: QuotaUsage): Promise<void> {
        this.callsByTenant.set(usage.tenantId, (this.callsByTenant.get(usage.tenantId) ?? 0) + 1)
        const t = this.tokensByTenant.get(usage.tenantId) ?? { in: 0, out: 0 }
        this.tokensByTenant.set(usage.tenantId, {
            in: t.in + usage.tokensIn,
            out: t.out + usage.tokensOut,
        })
    }
}
