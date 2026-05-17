import type { UIMessage } from 'ai'
import { AiQuotaDeniedError, runChatTurn } from 'maestro-core/runtime'

import type { ExampleCtx } from '@/lib/context'
import {
    exampleAuditStore,
    exampleKeyProvider,
    exampleMemoryStore,
    exampleQuotaStore,
    exampleTelemetry,
    exampleTurnStore,
} from '@/lib/ports'
import { allTools } from '@/lib/tools'

/**
 * Minimal chat endpoint backed by `runChatTurn`.
 *
 * The host's job is to:
 *   1. Build a `BaseToolContext`-shaped per-request context.
 *   2. Filter the tool registry for the active surface (this example
 *      shows all tools; production hosts would call `isAvailable` /
 *      transport filters here).
 *   3. Pass it all to `runChatTurn`, which handles: pre-call quota
 *      gate, model selection via `selectChatModel`, provider key
 *      resolution via `ModelKeyProvider`, AI SDK tool building with
 *      audit-wrapping, prompt-cache breakpoints, memory injection,
 *      `streamText`, turn-row lifecycle, post-call accounting, and
 *      the SSE Response.
 *
 * Pre-runChatTurn this route was ~78 LoC of hand-wiring; with the
 * kernel call it's ~30 LoC of actual logic.
 */
export const runtime = 'nodejs'
export const maxDuration = 60

const TIMEZONE = 'America/Sao_Paulo'

export async function POST(req: Request) {
    const body = (await req.json()) as { messages: UIMessage[] }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return Response.json({ error: 'messages array is required' }, { status: 400 })
    }

    const ctx: ExampleCtx = {
        tenantId: 'demo-workspace',
        principal: { id: 'demo-user', kind: 'user' },
        actor: 'human',
        transport: 'chat',
        locale: 'en-US',
        timezone: TIMEZONE,
        requestId: `req_${Date.now()}`,
        workspaceId: 'demo-workspace',
    }

    try {
        return await runChatTurn<ExampleCtx>({
            threadId: 'demo-thread',
            ctx,
            messages: body.messages,
            tools: allTools,
            systemPrompt: {
                static:
                    'You are a helpful assistant integrated with the Maestro agent runtime. ' +
                    'Three tools are available: echo (capitalises input), addNumbers (adds two numbers), getTime (returns current time). ' +
                    'Use them when the user asks for the corresponding action. Be concise.',
            },
            models: {
                fast: 'claude-haiku-4-5-20251001',
                smart: 'claude-sonnet-4-6',
            },
            ports: {
                turnStore: exampleTurnStore,
                keyProvider: exampleKeyProvider,
                auditStore: exampleAuditStore,
                memoryStore: exampleMemoryStore,
                quotaStore: exampleQuotaStore,
                telemetry: exampleTelemetry,
            },
        })
    } catch (e) {
        if (e instanceof AiQuotaDeniedError) {
            return Response.json(
                { error: 'quota_exceeded', payload: e.payload },
                { status: 429 }
            )
        }
        throw e
    }
}
