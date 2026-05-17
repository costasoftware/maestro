/**
 * Pure window-math helpers for `QuotaStore` implementations.
 *
 * The kernel itself does NOT use these directly — `runChatTurn` calls
 * `quotaStore.check()` and `quotaStore.record()` and trusts the port
 * to handle the storage. These helpers are EXPORTED for hosts so each
 * port impl computes consistent counter keys, TTLs, and reset times
 * without re-deriving them.
 *
 * Naming + TTL conventions:
 *   - Counter key:  `ai_quota:<metric>:<tenant>:<surface>:<window>`
 *   - Daily TTL:    26h (survives DST + late writes after midnight).
 *   - Hourly TTL:   65m (survives clock skew + late writes).
 *
 * All windows anchor to UTC. Multi-region replicas compute identical
 * keys without coordinating clocks. Hosts that want a different
 * timezone anchor should write their own helpers — most production
 * deployments are happiest on UTC.
 */
export const DAY_SECONDS = 60 * 60 * 24
export const HOUR_SECONDS = 60 * 60
export const DAY_TTL_SECONDS = DAY_SECONDS + HOUR_SECONDS // 26h
export const HOUR_TTL_SECONDS = HOUR_SECONDS + 60 * 5 // 65m

/** UTC date key for daily windows. Format: `YYYY-MM-DD`. */
export function dayKeyUtc(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10)
}

/** UTC hour key for hourly windows. Format: `YYYY-MM-DD-HH`. */
export function hourKeyUtc(now: Date = new Date()): string {
    return now.toISOString().slice(0, 13)
}

/** Unix seconds at the next UTC midnight from `now`. */
export function nextUtcMidnight(now: Date = new Date()): number {
    const next = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)
    )
    return Math.floor(next.getTime() / 1000)
}

/** Unix seconds at the next UTC hour boundary from `now`. */
export function nextUtcHour(now: Date = new Date()): number {
    const next = new Date(
        Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate(),
            now.getUTCHours() + 1,
            0,
            0,
            0
        )
    )
    return Math.floor(next.getTime() / 1000)
}

export interface WindowDescriptor {
    /** Storage key — Redis, Postgres column, KV namespace — host's choice. */
    key: string
    /** TTL in seconds for the storage backend (where applicable). */
    ttl: number
    /** Unix seconds at which this window resets — render on the deny UX. */
    resetAt: number
}

interface WindowArgs {
    tenantId: string
    surface: string
    now?: Date
}

export function dailyTokensWindow({ tenantId, surface, now = new Date() }: WindowArgs): WindowDescriptor {
    return {
        key: `ai_quota:tokens:${tenantId}:${surface}:${dayKeyUtc(now)}`,
        ttl: DAY_TTL_SECONDS,
        resetAt: nextUtcMidnight(now),
    }
}

export function dailyCostWindow({ tenantId, surface, now = new Date() }: WindowArgs): WindowDescriptor {
    return {
        key: `ai_quota:cost_cents:${tenantId}:${surface}:${dayKeyUtc(now)}`,
        ttl: DAY_TTL_SECONDS,
        resetAt: nextUtcMidnight(now),
    }
}

export function hourlyToolCallsWindow({
    tenantId,
    surface,
    now = new Date(),
}: WindowArgs): WindowDescriptor {
    return {
        key: `ai_quota:tool_calls:${tenantId}:${surface}:${hourKeyUtc(now)}`,
        ttl: HOUR_TTL_SECONDS,
        resetAt: nextUtcHour(now),
    }
}
