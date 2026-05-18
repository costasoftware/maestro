import {
    createUIMessageStream,
    createUIMessageStreamResponse,
    type UIMessage,
} from 'ai'
import { AiQuotaDeniedError, antiToolNarrationRule, runChatTurn } from '@maestro/core/runtime'

import { buildCtxFromHeaders } from '@/lib/auth'
import type { SupportBotCtx } from '@/lib/context'
import { supportBotPorts } from '@/lib/ports'
import { supportBotTools } from '@/lib/tools'

/**
 * Chat endpoint backed by `runChatTurn` with the `writer` arg path.
 *
 * Pre-filtering for the surface is done at the registry boundary —
 * we pass the full registry here because every tool in this example
 * supports both `'chat'` and `'mcp'`. A production host with a
 * surface-specific subset would do something like:
 *
 *   const eligible = supportBotTools.filter(t =>
 *       t.transports.includes('chat')
 *       && (t.actorScope?.includes(actor) ?? true)
 *   )
 *
 * before handing them to `runChatTurn`.
 */
export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: Request) {
    const body = (await req.json()) as { messages: UIMessage[]; threadId?: string }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return Response.json({ error: 'messages array is required' }, { status: 400 })
    }

    const ctx: SupportBotCtx = buildCtxFromHeaders({
        headers: req.headers,
        transport: 'chat',
        actor: 'agent',
    })
    const threadId = body.threadId ?? `thread_${ctx.workspaceId}_${ctx.principal?.id ?? 'anon'}`

    try {
        const stream = createUIMessageStream({
            execute: async ({ writer }) => {
                writer.write({
                    type: 'data-status',
                    data: { phase: 'thinking', at: new Date().toISOString() },
                })
                await runChatTurn<SupportBotCtx>({
                    threadId,
                    ctx,
                    messages: body.messages,
                    tools: supportBotTools,
                    systemPrompt: {
                        static:
                            `You are a customer-support copilot for a B2B SaaS. ` +
                            `You help human agents triage and resolve tickets. ` +
                            `You have five tools: lookupTicket, updateStatus, searchKb, escalate, summarise. ` +
                            `Always confirm the ticket id before making a status change. ` +
                            `Cite KB article slugs when you reference them.\n\n${antiToolNarrationRule()}`,
                        dynamic: `Current workspace: ${ctx.workspaceName} (id: ${ctx.workspaceId}).`,
                    },
                    models: {
                        fast: 'claude-haiku-4-5-20251001',
                        smart: 'claude-sonnet-4-6',
                    },
                    emptyRecoveryMode: 'enforce',
                    emptyRecoveryFallback:
                        'I called a tool but could not summarise the result. Could you rephrase?',
                    writer,
                    ports: supportBotPorts,
                })
            },
        })
        return createUIMessageStreamResponse({ stream })
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
