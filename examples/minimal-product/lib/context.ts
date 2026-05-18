import type { BaseToolContext } from '@maestro/core'

/**
 * The surfaces this example product invokes tools from. Narrowing the
 * `transport` field below to this union flips on the kernel's
 * compile-time check that every `defineAgentTool({ transports: [...] })`
 * literal is a member of `ExampleTransport`, and that every ctx-
 * construction site (route handler, MCP request adapter) sets
 * `transport` to one of these strings.
 *
 * Without the narrowed generic param, `BaseToolContext.transport`
 * defaults to `string` and the kernel can't distinguish a typo
 * (`'chta'`) or a mis-routed surface (`'admin'` when only `'chat' | 'mcp'`
 * are wired) from a legitimate transport — the registry filter silently
 * returns an empty tool set and the model falls back to emitting
 * `<function_calls>` XML in prose. Narrowing closes that trap.
 */
export type ExampleTransport = 'chat' | 'mcp'

/**
 * Per-request context for this example. Extends `BaseToolContext` with
 * one hypothetical host-specific field (`workspaceId`) to demonstrate
 * the generic-extension pattern that real products use.
 *
 * Real products replace these with their own domain types (e.g.
 * `BarbeiroCtx` adds `businessSlug`, `role`, `guestPhone`) and a
 * product-specific transport union (`'chat' | 'guest-chat' | 'whatsapp'
 * | 'mcp'` for barbeiro).
 */
export interface ExampleCtx extends BaseToolContext<ExampleTransport> {
    workspaceId?: string
}
