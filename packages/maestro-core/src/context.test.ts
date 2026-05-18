import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { BaseToolContext } from './context.js'
import { ok } from './envelope.js'
import { defineAgentTool } from './tool.js'

/**
 * Regression suite for the `BaseToolContext<TTransport>` generic.
 *
 * The bug this guards against: barbeiro v2 help-chat passed
 * `transport: surface as never` into the kernel because nothing forced
 * the surface vocabulary to overlap with the tool registry's accepted
 * transports. The registry filter silently produced an empty tool set,
 * Anthropic received `tools: {}`, and the model emitted
 * `<function_calls>` XML in prose instead of structured tool calls.
 *
 * With `BaseToolContext` parametrised over `TTransport`, a host that
 * narrows the generic param gets compile-time checks at TWO sites:
 *   1. ctx construction — `transport: 'admin'` must be a member of the
 *      host's transport union.
 *   2. tool definition — `transports: ['admin']` must overlap with the
 *      host's transport union.
 *
 * The `// @ts-expect-error` assertions below are the catch: if a future
 * refactor regresses either site back to free-form `string`, the
 * directives stop matching real errors and vitest fails the file.
 */

type StrictTransport = 'chat' | 'mcp'

interface StrictCtx extends BaseToolContext<StrictTransport> {
    role: 'admin' | 'guest'
}

const baseCtxFields = {
    tenantId: 't1',
    principal: { id: 'u1', kind: 'user' as const },
    actor: 'human',
    locale: 'en',
    timezone: 'UTC',
    requestId: 'req_test',
}

describe('BaseToolContext<TTransport> compile-time gates', () => {
    it('accepts a ctx whose transport is a member of the narrowed union', () => {
        const goodCtx: StrictCtx = {
            ...baseCtxFields,
            transport: 'chat',
            role: 'admin',
        }
        expect(goodCtx.transport).toBe('chat')
    })

    it('rejects a ctx whose transport is not in the narrowed union', () => {
        const badCtx: StrictCtx = {
            ...baseCtxFields,
            // The trap site from barbeiro PR #377: passing the surface
            // vocabulary (`'admin'`) where the transport vocabulary
            // (`'chat' | 'mcp'`) belongs. Pre-generic, this required an
            // explicit `as never` cast to silence; post-generic, TS
            // catches it at the assignment.
            // @ts-expect-error 'admin' is not assignable to StrictTransport.
            transport: 'admin',
            role: 'admin',
        }
        // Runtime sanity — value still lands as written; the gate is
        // purely structural so `@ts-expect-error` confirms it fires.
        expect(badCtx.transport as string).toBe('admin')
    })

    it('accepts a tool whose transports are subset of the ctx transport union', () => {
        const tool = defineAgentTool<z.ZodObject<{ q: z.ZodString }>, { answered: boolean }, StrictCtx>({
            name: 'lookup',
            description: 'looks up by q',
            transports: ['chat', 'mcp'],
            inputSchema: z.object({ q: z.string() }),
            execute: async () => ok({ answered: true }),
        })
        expect(tool.transports).toEqual(['chat', 'mcp'])
    })

    it('rejects a tool whose transports list contains a value outside the ctx transport union', () => {
        const tool = defineAgentTool<z.ZodObject<Record<string, never>>, Record<string, never>, StrictCtx>({
            name: 'wrong',
            description: 'transport literal that the host does not advertise',
            // @ts-expect-error 'admin' is not assignable to StrictTransport.
            transports: ['admin'],
            inputSchema: z.object({}),
            execute: async () => ok({}),
        })
        // Runtime value preserved — directive guarantees the gate fired.
        expect(tool.transports as readonly string[]).toEqual(['admin'])
    })

    it('preserves free-form `string` transport when the generic is left at the default', () => {
        // Hosts that haven't migrated yet still compile with arbitrary
        // string transports. This is the source-compatibility guarantee
        // — narrowing is opt-in.
        const looseCtx: BaseToolContext = {
            ...baseCtxFields,
            transport: 'any-string-here',
        }
        expect(looseCtx.transport).toBe('any-string-here')

        const tool = defineAgentTool({
            name: 'loose',
            description: 'no narrowing applied at the call site',
            transports: ['anything', 'goes'],
            inputSchema: z.object({}),
            execute: async () => ok({}),
        })
        expect(tool.transports).toEqual(['anything', 'goes'])
    })
})
