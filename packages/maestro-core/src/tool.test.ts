import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { BaseToolContext } from './context.js'
import { ok } from './envelope.js'
import { defineAgentTool } from './tool.js'

const baseCtx: BaseToolContext = {
    tenantId: 't1',
    principal: { id: 'u1', kind: 'user' },
    actor: 'human',
    transport: 'chat',
    locale: 'en',
    timezone: 'UTC',
    requestId: 'req_test',
}

describe('defineAgentTool', () => {
    it('infers input and output types from zod schema + execute return', async () => {
        const tool = defineAgentTool({
            name: 'echo',
            description: 'echo back',
            transports: ['chat'],
            inputSchema: z.object({ msg: z.string() }),
            execute: async (input) => ok({ echoed: input.msg.toUpperCase() }),
        })

        const result = await tool.execute({ msg: 'hi' }, baseCtx)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.data.echoed).toBe('HI')
    })

    it('accepts an extended context shape via generic param', async () => {
        type BarbeiroCtx = BaseToolContext & { role: 'admin' | 'guest'; businessSlug?: string }

        const tool = defineAgentTool<z.ZodObject<{ id: z.ZodNumber }>, { found: boolean }, BarbeiroCtx>({
            name: 'lookup',
            description: 'lookup by id, requires admin role',
            transports: ['chat'],
            inputSchema: z.object({ id: z.number() }),
            isAvailable: (ctx) => ctx.role === 'admin',
            execute: async (_input, ctx) => ok({ found: ctx.role === 'admin' }),
        })

        const adminCtx: BarbeiroCtx = { ...baseCtx, role: 'admin' }
        const guestCtx: BarbeiroCtx = { ...baseCtx, role: 'guest' }

        expect(await tool.isAvailable!(adminCtx)).toBe(true)
        expect(await tool.isAvailable!(guestCtx)).toBe(false)
    })

    it('preserves optional metadata fields', () => {
        const tool = defineAgentTool({
            name: 'create',
            description: 'create a thing',
            transports: ['chat', 'mcp'],
            inputSchema: z.object({}),
            execute: async () => ok({}),
            kind: 'write',
            costBand: 'medium',
            requiresConfirmation: true,
            actorScope: ['human', 'mcp_owner'],
            scopes: ['write:things'],
            category: 'things',
            schemaVersion: 2,
        })

        expect(tool.kind).toBe('write')
        expect(tool.costBand).toBe('medium')
        expect(tool.requiresConfirmation).toBe(true)
        expect(tool.actorScope).toEqual(['human', 'mcp_owner'])
        expect(tool.scopes).toEqual(['write:things'])
        expect(tool.category).toBe('things')
        expect(tool.schemaVersion).toBe(2)
    })
})
