import { describe, expect, it } from 'vitest'

import { decideEmptyRecovery } from './empty-recovery.js'

const FALLBACK = 'Sorry, I had a hiccup. Please try again.'

describe('decideEmptyRecovery', () => {
    it('returns triggered=false when mode is off, regardless of signal', () => {
        const d = decideEmptyRecovery({
            mode: 'off',
            isToolLoopNoText: true,
            fallbackText: FALLBACK,
        })
        expect(d.triggered).toBe(false)
        expect(d.fallbackText).toBeNull()
        expect(d.persistedErrorCode).toBeNull()
    })

    it('returns triggered=false when the signal is not the recoverable case', () => {
        const d = decideEmptyRecovery({
            mode: 'enforce',
            isToolLoopNoText: false,
            fallbackText: FALLBACK,
        })
        expect(d.triggered).toBe(false)
        expect(d.fallbackText).toBeNull()
        expect(d.persistedErrorCode).toBeNull()
    })

    it('log_only mode emits the logged code without fallback text', () => {
        const d = decideEmptyRecovery({
            mode: 'log_only',
            isToolLoopNoText: true,
            fallbackText: FALLBACK,
        })
        expect(d.triggered).toBe(true)
        expect(d.mode).toBe('log_only')
        expect(d.fallbackText).toBeNull()
        expect(d.persistedErrorCode).toBe('tool_loop_no_text_logged')
    })

    it('enforce mode emits the fallback text and the recovered code', () => {
        const d = decideEmptyRecovery({
            mode: 'enforce',
            isToolLoopNoText: true,
            fallbackText: FALLBACK,
        })
        expect(d.triggered).toBe(true)
        expect(d.mode).toBe('enforce')
        expect(d.fallbackText).toBe(FALLBACK)
        expect(d.persistedErrorCode).toBe('tool_loop_no_text_recovered_fallback')
    })

    it('echoes the original mode in the decision', () => {
        const d = decideEmptyRecovery({
            mode: 'enforce',
            isToolLoopNoText: false,
            fallbackText: FALLBACK,
        })
        expect(d.mode).toBe('enforce')
    })
})
