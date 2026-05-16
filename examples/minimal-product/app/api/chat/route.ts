import { anthropic } from '@ai-sdk/anthropic'
import { convertToModelMessages, streamText, type UIMessage } from 'ai'
import { buildAiSdkTools } from 'maestro-core/adapters/ai-sdk'

import type { ExampleCtx } from '@/lib/context'
import { exampleAuditStore } from '@/lib/ports'
import { allTools } from '@/lib/tools'

/**
 * Minimal chat endpoint. Demonstrates how a host wires `maestro-core`
 * into a Next.js App Router route:
 *
 *   1. Build a context for the turn (tenantId, principal, transport, ...)
 *   2. Filter the tool registry for this transport (here: no filter,
 *      all 3 tools support `'chat'`).
 *   3. Call `buildAiSdkTools` to get the AI SDK `ToolSet`, with the
 *      AuditStore port wired so every tool call lands in the audit log.
 *   4. Pass the ToolSet to `streamText` from the Vercel AI SDK.
 *   5. Stream the UIMessage protocol back to the browser.
 *
 * Real products would also wire TurnStore (persist messages),
 * MemoryStore (long-lived facts), QuotaStore (rate limits), and the
 * full system-prompt + cache-breakpoint setup. Those land in P4 via
 * `runChatTurn` which is a single call replacing this hand-wiring.
 */
export const runtime = 'nodejs'
export const maxDuration = 60

const TIMEZONE = 'America/Sao_Paulo'

export async function POST(req: Request) {
    if (!process.env.ANTHROPIC_API_KEY) {
        return new Response(
            JSON.stringify({
                error: 'ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add a key.',
            }),
            { status: 500, headers: { 'content-type': 'application/json' } }
        )
    }

    const body = (await req.json()) as { messages: UIMessage[] }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return new Response(JSON.stringify({ error: 'messages array is required' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
        })
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

    const tools = buildAiSdkTools<ExampleCtx>({
        registry: allTools,
        ctx,
        audit: exampleAuditStore,
    })

    const result = streamText({
        model: anthropic('claude-haiku-4-5-20251001'),
        system:
            'You are a helpful assistant integrated with the Maestro agent runtime. ' +
            'Three tools are available: echo (capitalises input), addNumbers (adds two numbers), getTime (returns current time). ' +
            'Use them when the user asks for the corresponding action. Be concise.',
        messages: await convertToModelMessages(body.messages),
        tools,
        stopWhen: ({ steps }) => steps.length >= 4,
    })

    return result.toUIMessageStreamResponse()
}
