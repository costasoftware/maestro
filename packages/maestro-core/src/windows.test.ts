import { describe, expect, it } from 'vitest'

import {
    DAY_TTL_SECONDS,
    dailyCostWindow,
    dailyTokensWindow,
    dayKeyUtc,
    HOUR_TTL_SECONDS,
    hourKeyUtc,
    hourlyToolCallsWindow,
    nextUtcHour,
    nextUtcMidnight,
} from './windows.js'

const FROZEN = new Date('2026-05-17T14:23:45.000Z')

describe('window keys', () => {
    it('dayKeyUtc returns YYYY-MM-DD anchored to UTC', () => {
        expect(dayKeyUtc(FROZEN)).toBe('2026-05-17')
    })

    it('hourKeyUtc returns YYYY-MM-DD-HH', () => {
        expect(hourKeyUtc(FROZEN)).toBe('2026-05-17T14')
    })

    it('day boundary anchors to UTC midnight regardless of local TZ', () => {
        // 23:59 UTC and 00:01 UTC next day are in different daily windows.
        const lateOnDay1 = new Date('2026-05-17T23:59:00.000Z')
        const earlyOnDay2 = new Date('2026-05-18T00:01:00.000Z')
        expect(dayKeyUtc(lateOnDay1)).toBe('2026-05-17')
        expect(dayKeyUtc(earlyOnDay2)).toBe('2026-05-18')
    })
})

describe('reset-at computations', () => {
    it('nextUtcMidnight is the next UTC midnight in unix seconds', () => {
        const at = nextUtcMidnight(FROZEN)
        const expected = Math.floor(Date.UTC(2026, 4, 18, 0, 0, 0, 0) / 1000)
        expect(at).toBe(expected)
    })

    it('nextUtcHour is the next UTC hour boundary', () => {
        const at = nextUtcHour(FROZEN)
        const expected = Math.floor(Date.UTC(2026, 4, 17, 15, 0, 0, 0) / 1000)
        expect(at).toBe(expected)
    })

    it('nextUtcMidnight at 23:59 lands on next day', () => {
        const justBefore = new Date('2026-05-17T23:59:59.000Z')
        const at = nextUtcMidnight(justBefore)
        const expected = Math.floor(Date.UTC(2026, 4, 18, 0, 0, 0, 0) / 1000)
        expect(at).toBe(expected)
    })

    it('nextUtcHour at HH:59:59 lands on the next hour', () => {
        const justBefore = new Date('2026-05-17T14:59:59.000Z')
        const at = nextUtcHour(justBefore)
        const expected = Math.floor(Date.UTC(2026, 4, 17, 15, 0, 0, 0) / 1000)
        expect(at).toBe(expected)
    })
})

describe('window factories', () => {
    it('dailyTokensWindow composes key + ttl + resetAt', () => {
        const w = dailyTokensWindow({ tenantId: '42', surface: 'chat', now: FROZEN })
        expect(w.key).toBe('ai_quota:tokens:42:chat:2026-05-17')
        expect(w.ttl).toBe(DAY_TTL_SECONDS)
        expect(w.resetAt).toBe(nextUtcMidnight(FROZEN))
    })

    it('dailyCostWindow uses cost_cents segment', () => {
        const w = dailyCostWindow({ tenantId: 'acme', surface: 'guest', now: FROZEN })
        expect(w.key).toBe('ai_quota:cost_cents:acme:guest:2026-05-17')
        expect(w.ttl).toBe(DAY_TTL_SECONDS)
    })

    it('hourlyToolCallsWindow uses tool_calls segment + hourly TTL', () => {
        const w = hourlyToolCallsWindow({ tenantId: '7', surface: 'mcp', now: FROZEN })
        expect(w.key).toBe('ai_quota:tool_calls:7:mcp:2026-05-17T14')
        expect(w.ttl).toBe(HOUR_TTL_SECONDS)
        expect(w.resetAt).toBe(nextUtcHour(FROZEN))
    })

    it('two tenants on the same surface get distinct keys', () => {
        const a = dailyTokensWindow({ tenantId: 'a', surface: 'chat', now: FROZEN })
        const b = dailyTokensWindow({ tenantId: 'b', surface: 'chat', now: FROZEN })
        expect(a.key).not.toBe(b.key)
    })

    it('one tenant on two surfaces gets distinct keys', () => {
        const chat = dailyTokensWindow({ tenantId: '1', surface: 'chat', now: FROZEN })
        const guest = dailyTokensWindow({ tenantId: '1', surface: 'guest', now: FROZEN })
        expect(chat.key).not.toBe(guest.key)
    })
})
