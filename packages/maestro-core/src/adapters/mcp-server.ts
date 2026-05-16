import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZodTypeAny } from 'zod'

import type { BaseToolContext } from '../context.js'
import type { AuditStore } from '../ports/audit-store.js'
import { type Clock, SystemClock } from '../ports/clock.js'
import type { AgentToolDefinition } from '../tool.js'

/**
 * Register a registry of `AgentToolDefinition`s on an MCP server
 * instance. The host owns the `McpServer` lifecycle (per-request in
 * stateless HTTP mode, long-lived in stdio mode) — this adapter only
 * fills the tool list.
 *
 * Filtering (surface, actor scope, OAuth scopes, isAvailable) happens
 * BEFORE this call. Same pattern as `buildAiSdkTools`.
 *
 * On execute:
 *   - Success or envelope-error → JSON-stringified envelope returned
 *     as `text` content. `isError` mirrors `envelope.ok === false`.
 *   - Thrown exception → audit + the host's `onError` hook are
 *     called, then a JSON `{ ok: false, error }` payload is returned
 *     with `isError: true`. The throw is NOT propagated (MCP SDK
 *     expects the handler to resolve with an error result, not
 *     throw — different contract from AI SDK).
 */
export interface RegisterMcpToolsArgs<TCtx extends BaseToolContext> {
    server: McpServer
    /**
     * Registry already filtered for the surface. Typed with `any` slots so
     * arrays of tools with different concrete input/output shapes unify.
     */
    registry: readonly AgentToolDefinition<any, any, TCtx>[]
    ctx: TCtx
    audit?: AuditStore
    clock?: Clock
    /**
     * Observability hook for thrown exceptions (Sentry, OTel, etc.).
     * Receives the raw error and a tag bag.
     */
    onError?: (error: unknown, tags: Record<string, unknown>) => void
}

export function registerMcpTools<TCtx extends BaseToolContext>(
    args: RegisterMcpToolsArgs<TCtx>
): void {
    const clock = args.clock ?? new SystemClock()

    for (const def of args.registry) {
        args.server.registerTool(
            def.name,
            {
                description: def.description,
                inputSchema: zodToRawShape(def.inputSchema),
            },
            async (input: unknown) => {
                const startedAt = clock.now()
                try {
                    const envelope = await def.execute(input as never, args.ctx)
                    if (args.audit) {
                        void args.audit.recordToolCall({
                            toolName: def.name,
                            transport: args.ctx.transport,
                            actor: args.ctx.actor,
                            tenantId: args.ctx.tenantId,
                            principalId: args.ctx.principal?.id ?? null,
                            requestId: args.ctx.requestId ?? null,
                            input,
                            output: envelope.ok
                                ? { ok: true }
                                : {
                                      ok: false,
                                      code: envelope.error.code,
                                      message: envelope.error.message,
                                  },
                            durationMs: clock.now().getTime() - startedAt.getTime(),
                            createdAt: startedAt,
                        })
                    }
                    return {
                        content: [
                            { type: 'text', text: JSON.stringify(envelope, null, 2) },
                        ],
                        isError: !envelope.ok,
                    }
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e)
                    if (args.audit) {
                        void args.audit.recordToolCall({
                            toolName: def.name,
                            transport: args.ctx.transport,
                            actor: args.ctx.actor,
                            tenantId: args.ctx.tenantId,
                            principalId: args.ctx.principal?.id ?? null,
                            requestId: args.ctx.requestId ?? null,
                            input,
                            output: { ok: false, code: 'tool_exception', message },
                            durationMs: clock.now().getTime() - startedAt.getTime(),
                            createdAt: startedAt,
                        })
                    }
                    if (args.onError) {
                        try {
                            args.onError(e, {
                                toolName: def.name,
                                transport: args.ctx.transport,
                                actor: args.ctx.actor,
                                tenantId: args.ctx.tenantId,
                                principalId: args.ctx.principal?.id ?? null,
                                requestId: args.ctx.requestId ?? null,
                            })
                        } catch {
                            // Observability must never crash the tool result.
                        }
                    }
                    return {
                        content: [
                            { type: 'text', text: JSON.stringify({ ok: false, error: message }) },
                        ],
                        isError: true,
                    }
                }
            }
        )
    }
}

/**
 * The MCP SDK's `registerTool` wants the input schema as a raw Zod
 * shape (`{ key: z.foo() }`), not the wrapped `z.object`. We crack
 * open the internal `_def.shape()` getter to extract it.
 *
 * Unknown / non-object schemas fall through to an empty shape — the
 * MCP server will accept any input for tools that don't declare one,
 * matching the behaviour of barbeiro's original adapter.
 */
function zodToRawShape(schema: unknown): Record<string, ZodTypeAny> {
    const s = schema as {
        _def?: { shape?: () => Record<string, ZodTypeAny> }
        shape?: Record<string, ZodTypeAny>
    }
    if (s && typeof s._def?.shape === 'function') {
        return s._def.shape()
    }
    if (s && typeof s.shape === 'object' && s.shape !== null) {
        return s.shape
    }
    return {}
}
