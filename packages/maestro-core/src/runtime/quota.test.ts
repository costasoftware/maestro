import { describe, expect, it } from 'vitest'

import type { QuotaState } from '../ports/quota-store.js'
import { AiQuotaDeniedError, enforceQuotaOrThrow } from './quota.js'

const windowEnd = new Date('2026-05-18T00:00:00.000Z')

function state(over: Partial<QuotaState['used']>, ceilings: QuotaState['ceilings'] = {}): QuotaState {
    return {
        ceilings,
        used: {
            tokensIn: 0,
            tokensOut: 0,
            calls: 0,
            usdMicro: 0,
            ...over,
        },
        windowStart: new Date('2026-05-17T00:00:00.000Z'),
        windowEnd,
    }
}

describe('enforceQuotaOrThrow', () => {
    it('does not throw when all counters are under ceiling', () => {
        expect(() =>
            enforceQuotaOrThrow({
                tenantId: '1',
                surface: 'chat',
                state: state({ tokensIn: 100 }, { maxTokensIn: 1000 }),
            })
        ).not.toThrow()
    })

    it('throws AiQuotaDeniedError on input_tokens cap', () => {
        try {
            enforceQuotaOrThrow({
                tenantId: '1',
                surface: 'chat',
                state: state({ tokensIn: 1000 }, { maxTokensIn: 1000 }),
            })
            throw new Error('should have thrown')
        } catch (e) {
            expect(e).toBeInstanceOf(AiQuotaDeniedError)
            const err = e as AiQuotaDeniedError
            expect(err.payload.reason).toBe('input_tokens')
            expect(err.payload.ceiling).toBe(1000)
            expect(err.payload.current).toBe(1000)
            expect(err.payload.tenantId).toBe('1')
            expect(err.payload.surface).toBe('chat')
        }
    })

    it('checks output_tokens after input_tokens', () => {
        const e = catchOrThrow(() =>
            enforceQuotaOrThrow({
                tenantId: '1',
                surface: 'chat',
                state: state(
                    { tokensOut: 500 },
                    { maxTokensIn: 1000, maxTokensOut: 500 }
                ),
            })
        )
        expect(e.payload.reason).toBe('output_tokens')
    })

    it('checks tool_calls after token caps', () => {
        const e = catchOrThrow(() =>
            enforceQuotaOrThrow({
                tenantId: '1',
                surface: 'chat',
                state: state({ calls: 60 }, { maxCallsPerWindow: 60 }),
            })
        )
        expect(e.payload.reason).toBe('tool_calls')
    })

    it('checks cost_usd_micro last', () => {
        const e = catchOrThrow(() =>
            enforceQuotaOrThrow({
                tenantId: '1',
                surface: 'chat',
                state: state({ usdMicro: 50_000 }, { maxUsdMicro: 50_000 }),
            })
        )
        expect(e.payload.reason).toBe('cost_usd_micro')
    })

    it('skips counters with undefined ceiling (unbounded)', () => {
        expect(() =>
            enforceQuotaOrThrow({
                tenantId: '1',
                surface: 'chat',
                state: state({ tokensIn: 999_999 }, {}),
            })
        ).not.toThrow()
    })

    it('skips counters with zero ceiling (treated as misseed, not deny)', () => {
        expect(() =>
            enforceQuotaOrThrow({
                tenantId: '1',
                surface: 'chat',
                state: state({ tokensIn: 999 }, { maxTokensIn: 0 }),
            })
        ).not.toThrow()
    })

    it('throws on exact ceiling (>=, not >)', () => {
        const e = catchOrThrow(() =>
            enforceQuotaOrThrow({
                tenantId: '1',
                surface: 'chat',
                state: state({ tokensIn: 100 }, { maxTokensIn: 100 }),
            })
        )
        expect(e.payload.reason).toBe('input_tokens')
    })

    it('error carries windowEnd Date for UI rendering', () => {
        const e = catchOrThrow(() =>
            enforceQuotaOrThrow({
                tenantId: '1',
                surface: 'chat',
                state: state({ tokensIn: 1 }, { maxTokensIn: 1 }),
            })
        )
        expect(e.payload.windowEnd).toEqual(windowEnd)
    })

    it('instanceof check survives across module boundaries', () => {
        const e = catchOrThrow(() =>
            enforceQuotaOrThrow({
                tenantId: '1',
                surface: 'chat',
                state: state({ tokensIn: 1 }, { maxTokensIn: 1 }),
            })
        )
        expect(e instanceof AiQuotaDeniedError).toBe(true)
        expect(e instanceof Error).toBe(true)
    })
})

function catchOrThrow(fn: () => void): AiQuotaDeniedError {
    try {
        fn()
        throw new Error('did not throw')
    } catch (e) {
        if (e instanceof AiQuotaDeniedError) return e
        throw e
    }
}
