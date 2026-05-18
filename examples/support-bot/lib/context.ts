import type { BaseToolContext } from '@maestro/core'

/**
 * Transports this product exposes. Two surfaces:
 *
 *   - `'chat'` — the browser UI (authenticated agent operator using the
 *     in-page widget at `/`).
 *   - `'mcp'`  — the MCP server endpoint at `/api/mcp` consumed by
 *     external Claude Desktop / Cursor / other MCP clients via header
 *     auth (`x-support-bot-workspace`, `x-support-bot-agent`).
 *
 * Narrowing `BaseToolContext`'s generic transport param to this union
 * is the load-bearing line: every `defineAgentTool({ transports: [...] })`
 * literal becomes compile-checked against `SupportBotTransport`, and
 * every ctx-construction site (route handler, MCP request adapter)
 * must set `transport` to one of these strings.
 *
 * The default `string` would let a typo (`'chta'`) or a stale surface
 * literal (`'agent'` when only `'chat' | 'mcp'` are wired) compile —
 * the registry filter then silently returns an empty tool set and
 * Anthropic falls back to emitting `<function_calls>` XML in prose
 * (the symptom of trap 4 in the kernel's README). Narrowing closes
 * that trap structurally at the type system level.
 */
export type SupportBotTransport = 'chat' | 'mcp'

/**
 * Host-defined actor strings. The host owns this enum; the kernel
 * only logs it for governance + abuse detection. We keep two values
 * to demonstrate the gating pattern (an MCP client should not be able
 * to invoke a tool gated to the human agent and vice versa).
 *
 *   - `'agent'`      — human support agent using the browser chat
 *   - `'mcp-client'` — an external MCP client (Claude Desktop, etc.)
 *                      invoking the tools via the MCP transport
 */
export type SupportBotActor = 'agent' | 'mcp-client'

/**
 * Per-request context for the support bot.
 *
 * Compare the shape choices to the two sibling host shapes:
 *
 * | Field          | `minimal-product` (single-tenant demo) | `support-bot` (this) | `barbeiro-app` (production multi-tenant SaaS) |
 * | -------------- | -------------------------------------- | -------------------- | --------------------------------------------- |
 * | `tenantId`     | hard-coded `'demo-workspace'`          | `workspace_<n>`      | `String(business.id)` (numeric)               |
 * | `transport`    | `'chat' \| 'mcp'`                      | `'chat' \| 'mcp'`    | `'chat' \| 'guest-chat' \| 'whatsapp' \| 'mcp'` |
 * | extra fields   | `workspaceId?` (vestigial)             | `workspaceId`        | `user`, `role`, `businessId`, `businessSlug`  |
 * | locale         | hard-coded `'en-US'`                   | hard-coded `'en-US'` | `pt-BR` / `es` / `en` (next-intl)             |
 *
 * Same kernel base type, three different host shapes — each narrowing
 * the transport union to its own product's surface set.
 */
export interface SupportBotCtx extends BaseToolContext<SupportBotTransport> {
    /** String workspace id (e.g. `'workspace_acme'`). Not numeric. */
    workspaceId: string
    /** Human-readable workspace label, for log + telemetry context. */
    workspaceName: string
}
