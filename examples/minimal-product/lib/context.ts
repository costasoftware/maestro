import type { BaseToolContext } from 'maestro-core'

/**
 * Per-request context for this example. Extends `BaseToolContext` with
 * one hypothetical host-specific field (`workspaceId`) to demonstrate
 * the generic-extension pattern that real products use.
 *
 * Real products replace these with their own domain types (e.g.
 * `BarbeiroCtx` adds `businessSlug`, `role`, `guestPhone`).
 */
export interface ExampleCtx extends BaseToolContext {
    workspaceId?: string
}
