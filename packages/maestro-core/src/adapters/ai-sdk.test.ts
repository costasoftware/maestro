import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { BaseToolContext } from '../context.js'
import { err, ok } from '../envelope.js'
import type { AuditStore } from '../ports/audit-store.js'
import { FixedClock } from '../ports/clock.js'
import { defineAgentTool } from '../tool.js'
import { buildAiSdkTools } from './ai-sdk.js'

const ctx: BaseToolContext = {
    tenantId: 't1',
    principal: { id: 'p1', kind: 'user' },
    actor: 'human',
    transport: 'chat',
    locale: 'en',
    timezone: 'UTC',
    requestId: 'req_test',
}

function tools() {
    return [
        defineAgentTool({
            name: 'greet',
            description: 'greet',
            transports: ['chat'],
            inputSchema: z.object({ name: z.string() }),
            execute: async (input) => ok({ greeting: `hi ${input.name}` }),
        }),
        defineAgentTool({
            name: 'boom',
            description: 'throws',
            transports: ['chat'],
            inputSchema: z.object({}),
            execute: async () => {
                throw new Error('kaboom')
            },
        }),
        defineAgentTool({
            name: 'fail',
            description: 'returns envelope error',
            transports: ['chat'],
            inputSchema: z.object({}),
            execute: async () => err('NOT_FOUND', 'no such record'),
        }),
    ]
}

describe('buildAiSdkTools', () => {
    it('produces a ToolSet keyed by tool name', () => {
        const set = buildAiSdkTools({ registry: tools(), ctx })
        expect(Object.keys(set).sort()).toEqual(['boom', 'fail', 'greet'])
    })

    it('routes execute and writes audit on success', async () => {
        const audit: AuditStore = { recordToolCall: vi.fn().mockResolvedValue(undefined) }
        const set = buildAiSdkTools({
            registry: tools(),
            ctx,
            audit,
            clock: new FixedClock(new Date('2026-05-16T00:00:00.000Z')),
        })

        // The AI SDK `tool()` factory returns an object whose execute is the
        // adapter's wrapper. Calling it bypasses the LLM and runs our wrap.
        const result = await (set.greet as { execute: (i: unknown, opts: object) => Promise<unknown> }).execute(
            { name: 'world' },
            {}
        )
        expect(result).toEqual({ ok: true, data: { greeting: 'hi world' } })

        // Audit was called fire-and-forget; await microtask flush.
        await new Promise((r) => setImmediate(r))
        expect(audit.recordToolCall).toHaveBeenCalledTimes(1)
        const call = (audit.recordToolCall as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as {
            toolName: string
            output: unknown
        }
        expect(call.toolName).toBe('greet')
        expect(call.output).toEqual({ ok: true })
    })

    it('writes audit AND rethrows on tool exception, invoking onError', async () => {
        const audit: AuditStore = { recordToolCall: vi.fn().mockResolvedValue(undefined) }
        const onError = vi.fn()
        const set = buildAiSdkTools({ registry: tools(), ctx, audit, onError })

        await expect(
            (set.boom as { execute: (i: unknown, opts: object) => Promise<unknown> }).execute({}, {})
        ).rejects.toThrow('kaboom')

        await new Promise((r) => setImmediate(r))
        expect(audit.recordToolCall).toHaveBeenCalledTimes(1)
        const call = (audit.recordToolCall as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as {
            output: { ok: boolean; code?: string }
        }
        expect(call.output.ok).toBe(false)
        expect(call.output.code).toBe('tool_exception')
        expect(onError).toHaveBeenCalledOnce()
    })

    it('captures envelope-error path with code in audit', async () => {
        const audit: AuditStore = { recordToolCall: vi.fn().mockResolvedValue(undefined) }
        const set = buildAiSdkTools({ registry: tools(), ctx, audit })

        const result = (await (set.fail as { execute: (i: unknown, opts: object) => Promise<unknown> }).execute(
            {},
            {}
        )) as { ok: false; error: { code: string } }
        expect(result.ok).toBe(false)
        expect(result.error.code).toBe('NOT_FOUND')

        await new Promise((r) => setImmediate(r))
        const call = (audit.recordToolCall as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as {
            output: { ok: boolean; code?: string }
        }
        expect(call.output).toEqual({ ok: false, code: 'NOT_FOUND', message: 'no such record' })
    })
})
