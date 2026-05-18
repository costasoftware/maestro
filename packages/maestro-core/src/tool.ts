import type { z } from 'zod'

import type { BaseToolContext } from './context.js'
import type { ToolEnvelope, ToolMeta } from './envelope.js'

/**
 * Coarse classification used by adapters and admin dashboards.
 *
 * - `read`        — pure lookup, no side effects.
 * - `write`       — mutates host state. Usually pairs with `requiresConfirmation`.
 * - `navigation`  — emits a UX hint (e.g. open a screen). No state change.
 */
export type ToolKind = 'read' | 'write' | 'navigation'

/** Hint for rate-limit tiering and cost dashboards. */
export type ToolCostBand = 'cheap' | 'medium' | 'expensive'

/**
 * Definition of a single agent tool. Pure — adapters translate this
 * into AI-SDK / MCP / Anthropic-messages shape at the boundary.
 *
 * Required fields are the irreducible minimum every tool author must
 * supply. Everything else is optional to keep the surface tight for
 * sibling products that don't share barbeiro-specific governance
 * (OAuth scopes, confirmation prompts, cost banding).
 */
export interface AgentToolDefinition<
    TInput extends z.ZodTypeAny,
    TOutput,
    TCtx extends BaseToolContext<string> = BaseToolContext,
> {
    /** Public identifier the model sees. camelCase by convention. */
    name: string

    /**
     * Entire selection signal for the model. Be explicit about *when*
     * and *when not* to call this tool. Vague descriptions cause misfires.
     */
    description: string

    /** Zod schema for tool input. Drives both validation and JSON-Schema export. */
    inputSchema: TInput

    /**
     * Surfaces where this tool is offered. Adapters filter the registry
     * via `def.transports.includes(transport)`. Element type is
     * `TCtx['transport']`, so when the host narrows its ctx transport
     * union, a tool with a stale or unknown transport literal
     * (`['admin']` vs `'chat' | 'mcp'`) fails to compile — closing the
     * surface-vs-transport trap that previously required an explicit
     * `as never` cast at the kernel boundary to silence. Hosts that
     * leave `TCtx['transport']` as the default `string` keep the
     * pre-existing free-form behaviour.
     */
    transports: readonly TCtx['transport'][]

    /**
     * Per-request gate. Runs BEFORE the tool is offered to the model.
     * Failing gate = tool is not advertised that turn. Async OK
     * (feature flags, downstream-config checks).
     */
    isAvailable?: (ctx: TCtx) => boolean | Promise<boolean>

    /**
     * Tool body. Returns a `ToolEnvelope` so failures surface as data
     * the model can recover from, instead of throwing.
     *
     * Throwing is allowed — adapters wrap `execute` so the throw is
     * captured by the host-provided onError hook and surfaced as a
     * tool-error result to the model. See `safe-tool.ts`.
     */
    execute: (input: z.infer<TInput>, ctx: TCtx) => Promise<ToolEnvelope<TOutput>>

    // ── Optional metadata ─────────────────────────────────────────────────
    kind?: ToolKind
    costBand?: ToolCostBand

    /**
     * Which host-defined actor strings may invoke this tool. Adapters
     * filter on this in addition to `transports` so the same surface
     * can serve different actor populations (owner-MCP vs client-MCP).
     */
    actorScope?: readonly string[]

    /**
     * OAuth scope strings consulted by the MCP adapter. Ignored by
     * non-OAuth adapters.
     */
    scopes?: readonly string[]

    /** Destructive writes should preview-then-commit at the surface layer. */
    requiresConfirmation?: boolean

    /** Free-form grouping for admin UI and MCP directory listings. */
    category?: string

    /** Default `meta` returned with every successful envelope. */
    meta?: ToolMeta

    /** Schema version. Bump on input/output breaking changes. */
    schemaVersion?: number
}

/**
 * Identity-factory for tool definitions. Lets call sites write
 * `defineAgentTool({...})` without spelling out the generics — TS
 * infers `TInput` from the zod literal and `TOutput` from the execute
 * return type. `TCtx` defaults to `BaseToolContext` and is set
 * explicitly when the host needs its extended context shape.
 */
export function defineAgentTool<
    TInput extends z.ZodTypeAny,
    TOutput,
    TCtx extends BaseToolContext<string> = BaseToolContext,
>(
    def: AgentToolDefinition<TInput, TOutput, TCtx>
): AgentToolDefinition<TInput, TOutput, TCtx> {
    return def
}

/** Convenient existential for registries that hold mixed tools. */
export type AnyAgentToolDefinition<TCtx extends BaseToolContext<string> = BaseToolContext> =
    AgentToolDefinition<z.ZodTypeAny, unknown, TCtx>
