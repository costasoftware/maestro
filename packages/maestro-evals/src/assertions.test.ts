import { describe, expect, it } from 'vitest'

import {
    assertNoForbiddenPhrases,
    assertNoToolNarrationXml,
    assertNoToolsCalled,
    assertTextMinLength,
    assertToolFiredHasText,
    assertToolsCalled,
    assertToolsRegistered,
    EvalAssertionError,
    TOOL_NARRATION_XML_TOKENS,
} from './assertions.js'

describe('assertNoToolNarrationXml', () => {
    it('passes on clean prose', () => {
        expect(() =>
            assertNoToolNarrationXml('I looked up the booking and it is confirmed.')
        ).not.toThrow()
    })

    it('passes on empty string', () => {
        expect(() => assertNoToolNarrationXml('')).not.toThrow()
    })

    it.each([
        '<function_calls>',
        '<invoke>',
        '</invoke>',
        '</function_calls>',
    ])('throws when text contains %s', (token) => {
        const sample = `Sure, I'll do that. ${token}<param>oops</param>`
        try {
            assertNoToolNarrationXml(sample)
            throw new Error('should have thrown')
        } catch (e) {
            expect(e).toBeInstanceOf(EvalAssertionError)
            expect((e as EvalAssertionError).code).toBe('xml_in_prose')
            expect((e as EvalAssertionError).details).toMatchObject({ token })
        }
    })

    it('exposes the legacy XML token set for reuse', () => {
        // Smoke check — keeps the public constant in lockstep with the
        // assertion body so callers can build complementary regexes.
        expect(TOOL_NARRATION_XML_TOKENS).toContain('<function_calls>')
        expect(TOOL_NARRATION_XML_TOKENS).toContain('<invoke>')
    })
})

describe('assertToolFiredHasText', () => {
    it('passes when tools fired AND text is non-empty', () => {
        expect(() =>
            assertToolFiredHasText([{ toolName: 'lookup' }], 'Here is the answer.')
        ).not.toThrow()
    })

    it('passes when no tools fired and text is empty (legitimate refusal-no-tools case has its own assertion)', () => {
        // No tools, no text — assertion is silent. Other helpers
        // (assertTextMinLength) catch the empty-bubble case when needed.
        expect(() => assertToolFiredHasText([], '')).not.toThrow()
    })

    it('passes when no tools fired and text is non-empty', () => {
        expect(() => assertToolFiredHasText([], 'Sorry, I cannot help with that.')).not.toThrow()
    })

    it('throws when tools fired but text is empty', () => {
        try {
            assertToolFiredHasText([{ toolName: 'lookup' }], '')
            throw new Error('should have thrown')
        } catch (e) {
            expect(e).toBeInstanceOf(EvalAssertionError)
            expect((e as EvalAssertionError).code).toBe('tool_fired_no_text')
        }
    })

    it('treats whitespace-only text as empty', () => {
        expect(() =>
            assertToolFiredHasText([{ toolName: 'lookup' }], '   \n  \t  ')
        ).toThrow(EvalAssertionError)
    })

    it('reports the actual tool-call count in details', () => {
        try {
            assertToolFiredHasText([{ toolName: 'a' }, { toolName: 'b' }, { toolName: 'c' }], '')
        } catch (e) {
            expect((e as EvalAssertionError).details).toMatchObject({ toolCallCount: 3 })
        }
    })
})

describe('assertToolsRegistered', () => {
    it('passes on non-empty registry', () => {
        expect(() => assertToolsRegistered([{ name: 'lookup' }])).not.toThrow()
    })

    it('throws on empty registry', () => {
        try {
            assertToolsRegistered([])
            throw new Error('should have thrown')
        } catch (e) {
            expect(e).toBeInstanceOf(EvalAssertionError)
            expect((e as EvalAssertionError).code).toBe('empty_tool_registry')
        }
    })
})

describe('assertToolsCalled', () => {
    it('passes when all expected names appear (toolName key)', () => {
        expect(() =>
            assertToolsCalled([{ toolName: 'lookup' }, { toolName: 'search' }], ['lookup'])
        ).not.toThrow()
    })

    it('passes when names appear under legacy `name` key', () => {
        expect(() => assertToolsCalled([{ name: 'lookup' }], ['lookup'])).not.toThrow()
    })

    it('passes when calls are bare strings', () => {
        expect(() => assertToolsCalled(['lookup', 'search'], ['lookup'])).not.toThrow()
    })

    it('throws when an expected name is missing', () => {
        try {
            assertToolsCalled([{ toolName: 'lookup' }], ['search'])
            throw new Error('should have thrown')
        } catch (e) {
            expect(e).toBeInstanceOf(EvalAssertionError)
            expect((e as EvalAssertionError).code).toBe('missing_tool_call')
            expect((e as EvalAssertionError).details).toMatchObject({
                expected: 'search',
                actuallyCalled: ['lookup'],
            })
        }
    })

    it('ignores duck-typed calls with no recognisable name field', () => {
        // A garbage call object never matches anything; the assertion
        // should still fail on the missing expected name, NOT throw on
        // the unknown-shape input.
        expect(() => assertToolsCalled([{ what: 'is this' }], ['lookup'])).toThrow(
            EvalAssertionError
        )
    })
})

describe('assertNoToolsCalled', () => {
    it('passes when no tools fired', () => {
        expect(() => assertNoToolsCalled([])).not.toThrow()
    })

    it('throws when any tool fired', () => {
        try {
            assertNoToolsCalled([{ toolName: 'lookup' }])
            throw new Error('should have thrown')
        } catch (e) {
            expect(e).toBeInstanceOf(EvalAssertionError)
            expect((e as EvalAssertionError).code).toBe('unexpected_tool_call')
            expect((e as EvalAssertionError).details).toMatchObject({
                actuallyCalled: ['lookup'],
            })
        }
    })
})

describe('assertTextMinLength', () => {
    it('passes when text meets the floor', () => {
        expect(() => assertTextMinLength('hello world', 5)).not.toThrow()
    })

    it('throws when text is too short', () => {
        try {
            assertTextMinLength('hi', 10)
            throw new Error('should have thrown')
        } catch (e) {
            expect((e as EvalAssertionError).code).toBe('text_too_short')
            expect((e as EvalAssertionError).details).toMatchObject({
                actualLength: 2,
                minLength: 10,
            })
        }
    })

    it('trims whitespace before measuring', () => {
        expect(() => assertTextMinLength('   hi   ', 3)).toThrow(EvalAssertionError)
    })
})

describe('assertNoForbiddenPhrases', () => {
    it('passes when no forbidden phrase appears', () => {
        expect(() =>
            assertNoForbiddenPhrases('Booking confirmed.', ['I am an AI', 'as a language model'])
        ).not.toThrow()
    })

    it('throws when a forbidden phrase appears', () => {
        try {
            assertNoForbiddenPhrases('Sure, as a language model I will help.', [
                'as a language model',
            ])
            throw new Error('should have thrown')
        } catch (e) {
            expect((e as EvalAssertionError).code).toBe('forbidden_phrase')
            expect((e as EvalAssertionError).details).toMatchObject({
                phrase: 'as a language model',
            })
        }
    })

    it('passes on empty forbidden list', () => {
        expect(() => assertNoForbiddenPhrases('anything', [])).not.toThrow()
    })
})

describe('EvalAssertionError', () => {
    it('preserves code, message, and details', () => {
        const e = new EvalAssertionError('xml_in_prose', 'boom', { token: '<invoke>' })
        expect(e.name).toBe('EvalAssertionError')
        expect(e.code).toBe('xml_in_prose')
        expect(e.message).toBe('boom')
        expect(e.details).toEqual({ token: '<invoke>' })
        expect(e).toBeInstanceOf(Error)
    })
})
