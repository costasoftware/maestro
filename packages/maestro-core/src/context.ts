/**
 * Per-request context handed to every tool. Built by the host product
 * at the top of the chat-turn handler (route, worker, MCP request) from
 * the authenticated principal + the surface invoking the tool.
 *
 * The base shape is intentionally minimal — everything that is universal
 * to any tool-calling agent system. Hosts extend via intersection at the
 * `defineAgentTool<TInput, TOutput, TCtx>` call site:
 *
 * ```ts
 * type BarbeiroCtx = BaseToolContext & {
 *   businessSlug?: string
 *   guestPhone?: string
 *   role: HelpRole | null
 * }
 *
 * defineAgentTool<Input, Output, BarbeiroCtx>({ ... })
 * ```
 *
 * Per-tool generic param (not TS module augmentation) is the chosen
 * extension mechanism — keeps the augmentation scoped to one tool
 * instead of polluting a shared global interface, so siblings in a
 * future monorepo can't trip over each other's context shapes.
 */
export interface BaseToolContext {
    /**
     * Opaque tenant scope. The host product owns the meaning
     * (`businessId.toString()`, workspace UUID, org slug, etc.) — kernel
     * never parses it. Used for audit attribution, quota keys, memory
     * scoping, and telemetry tagging.
     */
    tenantId: string

    /**
     * Authenticated principal, or null for anonymous transports
     * (public widget, voice). `id` is opaque; `kind` is a host-defined
     * string that disambiguates principal populations
     * (`'user'`, `'guest'`, `'service-account'`, `'mcp-client'`, ...).
     */
    principal: { id: string; kind: string } | null

    /**
     * Who authorised the call. Logged for governance + abuse detection.
     * String-typed; the host owns the enum.
     */
    actor: string

    /**
     * Which surface invoked the call (`'chat'`, `'guest-chat'`,
     * `'whatsapp'`, `'mcp'`, ...). Adapters filter the registry by
     * `def.transports.includes(transport)`. String-typed; the host owns
     * the vocabulary.
     */
    transport: string

    /** IETF BCP-47 locale tag, e.g. `'pt-BR'`. */
    locale: string

    /** IANA timezone, e.g. `'America/Sao_Paulo'`. */
    timezone: string

    /** Trace id for cross-system correlation (matches HTTP `x-request-id`). */
    requestId: string
}
