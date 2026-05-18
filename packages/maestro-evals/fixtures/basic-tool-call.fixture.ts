import { defineAgentTool, ok } from '@costasoftware/maestro-core'
import { z } from 'zod'

import type { EvalFixture } from '../src/fixtures.js'

/**
 * Basic tool-call fixture — the cheapest end-to-end check that the
 * Anthropic tool-use round-trip is intact.
 *
 * Traps this fixture covers (when the static + live runner both
 * pass it):
 *   - Trap #1 (system position): the call-shape phase asserts a
 *     top-level system entry exists before the simulated/live model
 *     ever runs. Without it, no tool would fire.
 *   - Trap #2 (missing stopWhen): the `nonEmptyText` assertion fails
 *     when a tool fires but the bubble ends empty — the classic
 *     symptom of stopWhen defaulting to stepCountIs(1).
 *   - Trap #3 (anti-narration off): the `noXmlInProse` assertion
 *     catches `<function_calls>` / `<invoke>` leaks in the final
 *     text.
 *   - Trap #4 (empty tool registry): the registry guard fails when
 *     the surface-vs-transport filter collapses to zero tools.
 */
const lookupBooking = defineAgentTool({
    name: 'lookupBooking',
    description: 'Look up a booking by its short reference code.',
    transports: ['chat'],
    inputSchema: z.object({
        ref: z.string().describe('Short booking ref like "B-1234".'),
    }),
    execute: async ({ ref }) =>
        ok({
            ref,
            customer: 'Alice',
            scheduledAt: '2026-05-20T14:00:00Z',
            status: 'confirmed',
        }),
})

const fixture: EvalFixture = {
    name: 'basic-tool-call',
    description: 'Single-tool happy path — user asks for a booking, model invokes lookup and summarises.',
    prompt: 'Can you check booking B-1234 and tell me the customer and time?',
    tools: [lookupBooking],
    simulated: {
        text: 'Booking B-1234 is for Alice on 20 May 2026 at 14:00 UTC. Status: confirmed.',
        toolCalls: [{ name: 'lookupBooking' }],
    },
    expect: {
        toolCalls: ['lookupBooking'],
        noXmlInProse: true,
        nonEmptyText: true,
        minTextLength: 20,
    },
}

export default fixture
