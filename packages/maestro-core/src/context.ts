/**
 * Per-request context handed to every tool. Built by the host product
 * at the top of the chat-turn handler (route, worker, MCP request) from
 * the authenticated principal + the surface invoking the tool.
 *
 * The base shape is intentionally minimal — everything that is universal
 * to any tool-calling agent system. Hosts extend via intersection at the
 * `defineAgentTool<TInput, TOutput, TCtx>` call site, and narrow
 * `transport` to a host-owned union so the kernel can type-check tool
 * `transports: [...]` literals against the live surface set:
 *
 * ```ts
 * type BarbeiroTransport = 'chat' | 'guest-chat' | 'whatsapp' | 'mcp'
 *
 * interface BarbeiroCtx extends BaseToolContext<BarbeiroTransport> {
 *   businessSlug?: string
 *   guestPhone?: string
 *   role: HelpRole | null
 * }
 *
 * defineAgentTool<Input, Output, BarbeiroCtx>({
 *     transports: ['chat'],          // ✓ compiles
 *     // transports: ['admin'],      // ✗ TS error: not in BarbeiroTransport
 *     // ...
 * })
 * ```
 *
 * The `TTransport` generic defaults to `string`, so hosts that don't
 * yet opt in continue to compile unchanged. Narrowing is a one-line
 * change on the host's context interface; once applied, mismatched
 * `transports` literals AND a wrong ctx assignment (`transport: 'admin'`
 * when only `'chat' | 'mcp'` is allowed) both become compile-time
 * errors — no `as never` rescue remains.
 *
 * Per-tool generic param (not TS module augmentation) is the chosen
 * extension mechanism — keeps the augmentation scoped to one tool
 * instead of polluting a shared global interface, so siblings in a
 * future monorepo can't trip over each other's context shapes.
 */
export interface BaseToolContext<TTransport extends string = string> {
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
     * `def.transports.includes(transport)`. Defaults to `string` so
     * pre-existing hosts compile unchanged; narrow via the `TTransport`
     * generic to make `transports: [...]` literals on tool definitions
     * (and ctx-construction call sites) compile-checked against the
     * host's surface vocabulary.
     */
    transport: TTransport

    /** IETF BCP-47 locale tag, e.g. `'pt-BR'`. */
    locale: string

    /** IANA timezone, e.g. `'America/Sao_Paulo'`. */
    timezone: string

    /** Trace id for cross-system correlation (matches HTTP `x-request-id`). */
    requestId: string
}
