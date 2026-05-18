import { defineAgentTool, ok } from 'maestro-core'
import { z } from 'zod'

import type { EvalFixture } from '../src/fixtures.js'

/**
 * Multi-tool fixture — the user's ask needs TWO sequential tool
 * calls before the assistant can answer. Targets the missing-
 * `stopWhen` failure mode harder than `basic-tool-call`: a single
 * tool call can mask a `stepCountIs(1)` bug if the model happens to
 * produce text in the same response; a two-step chain cannot.
 *
 * Traps this fixture covers:
 *   - Trap #2 (missing stopWhen): with the default `stepCountIs(1)`,
 *     the second tool call (or the post-tool synthesis) never runs,
 *     so the chain fails the `toolCalls` assertion or the
 *     `nonEmptyText` assertion (or both).
 *   - Trap #3 (anti-narration off): noXmlInProse still applies to
 *     the final synthesis text.
 *   - Trap #4 (empty registry): registry guard fires on shape phase.
 *
 * NOT covered: trap #1 — same registry shape as basic-tool-call.
 */
const findCustomer = defineAgentTool({
    name: 'findCustomer',
    description: 'Look up a customer by name and return their internal id.',
    transports: ['chat'],
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) =>
        ok({
            id: 'cust_42',
            name,
            email: `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`,
        }),
})

const listBookings = defineAgentTool({
    name: 'listBookings',
    description: 'List upcoming bookings for a customer id.',
    transports: ['chat'],
    inputSchema: z.object({ customerId: z.string() }),
    execute: async ({ customerId }) =>
        ok({
            customerId,
            bookings: [
                { ref: 'B-1001', when: '2026-05-20T10:00:00Z' },
                { ref: 'B-1002', when: '2026-05-27T10:00:00Z' },
            ],
        }),
})

const fixture: EvalFixture = {
    name: 'multi-tool',
    description: 'Two sequential tool calls — find customer, then list their bookings.',
    prompt: 'Pull up Alice Silva\'s upcoming bookings.',
    tools: [findCustomer, listBookings],
    simulated: {
        text: 'Alice Silva has two upcoming bookings: B-1001 on 20 May and B-1002 on 27 May.',
        toolCalls: [{ name: 'findCustomer' }, { name: 'listBookings' }],
    },
    expect: {
        toolCalls: ['findCustomer', 'listBookings'],
        noXmlInProse: true,
        nonEmptyText: true,
        minTextLength: 40,
    },
}

export default fixture
