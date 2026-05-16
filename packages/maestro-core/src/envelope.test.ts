import { describe, expect, it } from 'vitest'

import { err, isOk, ok, type ToolEnvelope } from './envelope.js'

describe('envelope', () => {
    it('ok() wraps data without meta', () => {
        const e = ok({ x: 1 })
        expect(e.ok).toBe(true)
        if (e.ok) {
            expect(e.data.x).toBe(1)
            expect(e.meta).toBeUndefined()
        }
    })

    it('ok() preserves meta when supplied', () => {
        const e = ok({ x: 1 }, { uiRendered: 'card.bookings' })
        expect(e.ok && e.meta?.uiRendered).toBe('card.bookings')
    })

    it('err() shapes error envelope', () => {
        const e = err('NOT_FOUND', 'no such booking')
        expect(e.ok).toBe(false)
        if (!e.ok) {
            expect(e.error.code).toBe('NOT_FOUND')
            expect(e.error.message).toBe('no such booking')
        }
    })

    it('isOk() narrows the union', () => {
        const e: ToolEnvelope<{ id: number }> = ok({ id: 7 })
        if (isOk(e)) {
            // type narrowed — compile-time check
            expect(e.data.id).toBe(7)
        } else {
            throw new Error('unreachable')
        }
    })
})
