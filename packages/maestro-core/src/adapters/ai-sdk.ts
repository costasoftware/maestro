import { tool, type ToolSet } from 'ai'

import { applyCacheBreakpoints, type CacheableBlock, type CachedMessages } from '../cache-control.js'
import type { BaseToolContext } from '../context.js'
import type { AuditStore } from '../ports/audit-store.js'
import type { Clock } from '../ports/clock.js'
import { SystemClock } from '../ports/clock.js'
import { captureToolException, type ToolExceptionHandler } from '../safe-tool.js'
import type { AgentToolDefinition } from '../tool.js'

/**
 * Translate a registry of `AgentToolDefinition`s into a Vercel AI SDK
 * `ToolSet` ready to pass to `streamText` / `generateText`.
 *
 * Filtering happens BEFORE this call: the host runs each tool's
 * `isAvailable(ctx)` + `def.transports.includes(ctx.transport)` to
 * decide what to advertise; only the eligible subset reaches here.
 * Keeping eligibility outside the adapter means hosts can layer their
 * own gates (OAuth scopes, feature flags) on top without forking.
 *
 * Each tool's `execute` is wrapped in try/catch:
 *   1. On success: writes an audit row (if `audit` port provided).
 *   2. On envelope-error (`ok: false`): same audit row, just with the
 *      error code/message.
 *   3. On thrown exception: audit row tagged `tool_exception`, calls
 *      `onError` for observability, THEN rethrows so the AI SDK marks
 *      the tool result as `error` and the model sees it.
 *
 * The last tool in iteration order receives the Anthropic ephemeral
 * cacheControl marker (`applyCacheBreakpoints`). Cross-tenant cache
 * reuse depends on the tool registry bytes being identical across
 * tenants — keep tool descriptions tenant-invariant.
 */
export interface BuildAiSdkToolsArgs<TCtx extends BaseToolContext> {
    /**
     * Registry already filtered for the active surface + actor + isAvailable.
     * Typed as `AgentToolDefinition<any, any, TCtx>` (not `AnyAgentToolDefinition`)
     * so arrays mixing tools with different concrete input/output shapes unify
     * — the `any` slot allows the variance TS otherwise rejects.
     */
    registry: readonly AgentToolDefinition<any, any, TCtx>[]
    /** Request context — passed to every `execute` call. */
    ctx: TCtx
    /** Optional audit port. Calls are fire-and-forget. */
    audit?: AuditStore
    /** Optional observability hook for thrown exceptions. */
    onError?: ToolExceptionHandler
    /** Optional clock override (testing). */
    clock?: Clock
}

export function buildAiSdkTools<TCtx extends BaseToolContext>(
    args: BuildAiSdkToolsArgs<TCtx>
): ToolSet {
    const clock = args.clock ?? new SystemClock()
    const rawTools: ToolSet = {}

    for (const def of args.registry) {
        rawTools[def.name] = tool({
            description: def.description,
            inputSchema: def.inputSchema,
            execute: async (input: unknown) => {
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
                    return envelope
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
                    captureToolException(
                        e,
                        {
                            toolName: def.name,
                            transport: args.ctx.transport,
                            actor: args.ctx.actor,
                            tenantId: args.ctx.tenantId,
                            principalId: args.ctx.principal?.id ?? null,
                            requestId: args.ctx.requestId ?? null,
                        },
                        args.onError
                    )
                    throw e
                }
            },
        })
    }

    return rawTools
}

/**
 * Convenience wrapper: builds the ToolSet AND applies the
 * static-vs-dynamic system-prompt cache breakpoint in one call.
 *
 * Hosts that prefer to manage cache placement themselves (e.g. an
 * adapter combining a multi-segment system prompt with a third-party
 * RAG corpus) should call `buildAiSdkTools` + `applyCacheBreakpoints`
 * separately.
 */
export function buildCachedAiSdkSetup<TCtx extends BaseToolContext>(args: {
    build: BuildAiSdkToolsArgs<TCtx>
    cache: Omit<CacheableBlock<ToolSet>, 'static'> & {
        static: Omit<CacheableBlock<ToolSet>['static'], 'tools'>
    }
}): CachedMessages<ToolSet> {
    const tools = buildAiSdkTools(args.build)
    return applyCacheBreakpoints({
        static: { ...args.cache.static, tools },
        dynamic: args.cache.dynamic,
    })
}

export { type ToolSet } from 'ai'
