import { defineAgentTool, err, ok } from '@costasoftware/maestro-core'
import { z } from 'zod'

import type { ExampleCtx } from './context.js'

/**
 * Trivial echo tool — capitalises the input. Demonstrates the
 * zero-side-effect path: no I/O, no port use, just transforms input
 * and returns an `ok` envelope.
 */
export const echoTool = defineAgentTool<z.ZodObject<{ msg: z.ZodString }>, { echoed: string }, ExampleCtx>({
    name: 'echo',
    description:
        'Echoes the user message back in upper case. Useful for confirming the tool-calling pipeline is wired.',
    transports: ['chat'],
    kind: 'read',
    costBand: 'cheap',
    inputSchema: z.object({ msg: z.string().min(1).max(500) }),
    execute: async (input) => ok({ echoed: input.msg.toUpperCase() }),
})

/**
 * Pure-compute tool with deliberate error branches — shows the
 * envelope-error path the model can recover from.
 */
export const addNumbersTool = defineAgentTool<
    z.ZodObject<{ a: z.ZodNumber; b: z.ZodNumber }>,
    { sum: number },
    ExampleCtx
>({
    name: 'addNumbers',
    description:
        'Adds two finite real numbers. Returns NOT_FINITE if either input is NaN or Infinity, OVERFLOW if the sum exceeds Number.MAX_SAFE_INTEGER.',
    transports: ['chat'],
    kind: 'read',
    costBand: 'cheap',
    inputSchema: z.object({ a: z.number(), b: z.number() }),
    execute: async (input) => {
        if (!Number.isFinite(input.a) || !Number.isFinite(input.b)) {
            return err('NOT_FINITE', 'inputs must be finite numbers')
        }
        const sum = input.a + input.b
        if (Math.abs(sum) > Number.MAX_SAFE_INTEGER) {
            return err('OVERFLOW', 'sum exceeds Number.MAX_SAFE_INTEGER')
        }
        return ok({ sum })
    },
})

/**
 * Time tool — demonstrates context use (`ctx.timezone`) and intl
 * formatting. Real-product tools follow the same pattern: pull what
 * they need from `ctx`, never close over module-level state.
 */
export const getTimeTool = defineAgentTool<z.ZodObject<Record<string, never>>, { iso: string; readable: string }, ExampleCtx>({
    name: 'getTime',
    description:
        'Returns the current time as both an ISO 8601 timestamp and a human-readable string localised to the user timezone.',
    transports: ['chat'],
    kind: 'read',
    costBand: 'cheap',
    inputSchema: z.object({}),
    execute: async (_input, ctx) => {
        const now = new Date()
        const readable = new Intl.DateTimeFormat('en-US', {
            timeZone: ctx.timezone,
            dateStyle: 'medium',
            timeStyle: 'long',
        }).format(now)
        return ok({ iso: now.toISOString(), readable })
    },
})

export const allTools = [echoTool, addNumbersTool, getTimeTool]
