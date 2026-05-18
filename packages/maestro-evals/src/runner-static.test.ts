import { defineAgentTool, ok } from '@costasoftware/maestro-core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { EvalFixture } from './fixtures.js'
import { runStaticEvals } from './runner-static.js'

/**
 * Self-tests for the static runner. We build inline fixtures here
 * instead of loading the shipped /fixtures because (a) we want to
 * exercise the failure paths too, (b) keeping the test data inline
 * makes the assertion intent obvious.
 *
 * The console reporter writes to stdout — we don't suppress it
 * because vitest captures stdout per test and the noise is fine for
 * CI logs. The pass/fail signal is the returned EvalReport, which
 * is what we assert on.
 */

function lookupTool() {
    return defineAgentTool({
        name: 'lookup',
        description: 'look up by q',
        transports: ['chat'],
        inputSchema: z.object({ q: z.string() }),
        execute: async () => ok({ found: true }),
    })
}

describe('runStaticEvals — happy path', () => {
    it('passes a well-formed single-tool fixture', async () => {
        const fx: EvalFixture = {
            name: 'happy-single',
            prompt: 'look up apples',
            tools: [lookupTool()],
            simulated: {
                text: 'I found one matching result.',
                toolCalls: [{ name: 'lookup' }],
            },
            expect: {
                toolCalls: ['lookup'],
                noXmlInProse: true,
                nonEmptyText: true,
            },
        }

        const report = await runStaticEvals([fx], { reporter: 'json' })
        expect(report.passed).toBe(true)
        expect(report.results).toHaveLength(1)
        expect(report.results[0]?.passed).toBe(true)
        expect(report.results[0]?.failures).toEqual([])
    })

    it('passes a refusal fixture (no tools, prose answer)', async () => {
        const fx: EvalFixture = {
            name: 'happy-refusal',
            prompt: 'what is the meaning of life',
            tools: [lookupTool()],
            simulated: {
                text: "I can't help with that — outside my scope.",
                toolCalls: [],
            },
            expect: {
                noToolCalls: true,
                noXmlInProse: true,
            },
        }
        const report = await runStaticEvals([fx], { reporter: 'json' })
        expect(report.passed).toBe(true)
    })
})

describe('runStaticEvals — failure detection', () => {
    it('FAILS when simulated text contains <function_calls> XML (trap #3)', async () => {
        const fx: EvalFixture = {
            name: 'narration-leak',
            prompt: 'look up apples',
            tools: [lookupTool()],
            simulated: {
                text: '<function_calls><invoke name="lookup"><param>apples</param></invoke></function_calls> I found one.',
                toolCalls: [{ name: 'lookup' }],
            },
            expect: {
                toolCalls: ['lookup'],
            },
        }
        const report = await runStaticEvals([fx], { reporter: 'json' })
        expect(report.passed).toBe(false)
        const failures = report.results[0]?.failures ?? []
        expect(failures.some((f) => f.code === 'xml_in_prose')).toBe(true)
    })

    it('FAILS when tools fire but text is empty (trap #2)', async () => {
        const fx: EvalFixture = {
            name: 'empty-text-after-tool',
            prompt: 'look up apples',
            tools: [lookupTool()],
            simulated: {
                text: '',
                toolCalls: [{ name: 'lookup' }],
            },
            expect: {
                toolCalls: ['lookup'],
                nonEmptyText: true,
            },
        }
        const report = await runStaticEvals([fx], { reporter: 'json' })
        expect(report.passed).toBe(false)
        const codes = (report.results[0]?.failures ?? []).map((f) => f.code)
        expect(codes).toContain('tool_fired_no_text')
    })

    it('FAILS when tool registry is empty (trap #4)', async () => {
        const fx: EvalFixture = {
            name: 'empty-registry',
            prompt: 'anything',
            tools: [],
            simulated: { text: 'hi', toolCalls: [] },
            expect: { noToolCalls: true },
        }
        const report = await runStaticEvals([fx], { reporter: 'json' })
        expect(report.passed).toBe(false)
        const codes = (report.results[0]?.failures ?? []).map((f) => f.code)
        expect(codes).toContain('empty_tool_registry')
    })

    it('FAILS when an expected tool was not called', async () => {
        const fx: EvalFixture = {
            name: 'missing-call',
            prompt: 'do two things',
            tools: [lookupTool()],
            simulated: {
                text: 'done',
                toolCalls: [{ name: 'lookup' }],
            },
            expect: {
                toolCalls: ['lookup', 'expectedButMissing'],
            },
        }
        const report = await runStaticEvals([fx], { reporter: 'json' })
        expect(report.passed).toBe(false)
        const codes = (report.results[0]?.failures ?? []).map((f) => f.code)
        expect(codes).toContain('missing_tool_call')
    })

    it('FAILS when a refusal fixture invokes a tool anyway', async () => {
        const fx: EvalFixture = {
            name: 'refusal-but-called',
            prompt: 'off-scope ask',
            tools: [lookupTool()],
            simulated: {
                text: 'sure',
                toolCalls: [{ name: 'lookup' }],
            },
            expect: { noToolCalls: true },
        }
        const report = await runStaticEvals([fx], { reporter: 'json' })
        expect(report.passed).toBe(false)
        const codes = (report.results[0]?.failures ?? []).map((f) => f.code)
        expect(codes).toContain('unexpected_tool_call')
    })

    it('FAILS when text is shorter than minTextLength', async () => {
        const fx: EvalFixture = {
            name: 'too-short',
            prompt: 'explain',
            tools: [lookupTool()],
            simulated: { text: 'ok', toolCalls: [] },
            expect: { noToolCalls: true, minTextLength: 20 },
        }
        const report = await runStaticEvals([fx], { reporter: 'json' })
        expect(report.passed).toBe(false)
        const codes = (report.results[0]?.failures ?? []).map((f) => f.code)
        expect(codes).toContain('text_too_short')
    })

    it('FAILS when a forbidden phrase appears', async () => {
        const fx: EvalFixture = {
            name: 'forbidden',
            prompt: 'who are you',
            tools: [lookupTool()],
            simulated: {
                text: 'As a large language model, I cannot help.',
                toolCalls: [],
            },
            expect: {
                noToolCalls: true,
                forbiddenPhrases: ['As a large language model'],
            },
        }
        const report = await runStaticEvals([fx], { reporter: 'json' })
        expect(report.passed).toBe(false)
        const codes = (report.results[0]?.failures ?? []).map((f) => f.code)
        expect(codes).toContain('forbidden_phrase')
    })
})

describe('runStaticEvals — aggregate report', () => {
    it('runs multiple fixtures and aggregates pass/fail correctly', async () => {
        const passing: EvalFixture = {
            name: 'p1',
            prompt: 'go',
            tools: [lookupTool()],
            simulated: { text: 'ok done', toolCalls: [{ name: 'lookup' }] },
            expect: { toolCalls: ['lookup'] },
        }
        const failing: EvalFixture = {
            name: 'f1',
            prompt: 'go',
            tools: [lookupTool()],
            simulated: { text: '<invoke>oops</invoke>', toolCalls: [] },
            expect: { noToolCalls: true },
        }
        const report = await runStaticEvals([passing, failing], { reporter: 'json' })
        expect(report.passed).toBe(false)
        expect(report.results).toHaveLength(2)
        expect(report.results[0]?.passed).toBe(true)
        expect(report.results[1]?.passed).toBe(false)
    })
})
