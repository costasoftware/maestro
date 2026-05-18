import { defineAgentTool, ok } from 'maestro-core'
import { z } from 'zod'

import type { EvalFixture } from '../src/fixtures.js'

/**
 * Off-scope refusal fixture — the user asks for something none of
 * the available tools handle. The model should reply in prose with
 * a brief explanation and NOT invent a tool call.
 *
 * Traps this fixture covers:
 *   - Trap #3 (anti-narration off): even without a real tool firing,
 *     models sometimes fabricate `<function_calls>` XML when they
 *     "would" call a tool but can't. The noXmlInProse assertion
 *     catches that.
 *   - Trap #4 (empty registry): the registry guard still fires —
 *     this fixture is NOT a no-tools scenario. The model has tools;
 *     it just shouldn't use them for an off-scope ask.
 *
 * NOT covered: trap #1 / #2 (those require a tool to actually fire
 * — see basic-tool-call and multi-tool).
 */
const lookupBooking = defineAgentTool({
    name: 'lookupBooking',
    description: 'Look up a booking by its short reference code.',
    transports: ['chat'],
    inputSchema: z.object({ ref: z.string() }),
    execute: async ({ ref }) => ok({ ref, status: 'confirmed' }),
})

const fixture: EvalFixture = {
    name: 'refusal',
    description: 'Off-scope ask — model should refuse politely without inventing a tool call.',
    prompt: 'What is the population of Lisbon?',
    tools: [lookupBooking],
    simulated: {
        text: "I can help with booking lookups, but I don't have access to general knowledge like city populations. Please check a search engine for that.",
        toolCalls: [],
    },
    expect: {
        noToolCalls: true,
        noXmlInProse: true,
        nonEmptyText: true,
        minTextLength: 30,
        forbiddenPhrases: ['<function_calls>', '<invoke>'],
    },
}

export default fixture
