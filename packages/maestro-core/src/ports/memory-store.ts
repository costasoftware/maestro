/**
 * Per-principal long-lived facts that should travel between threads
 * within the same tenant. The model uses `saveMemoryTool` /
 * `forgetMemoryTool` to write here; the kernel loads relevant entries
 * into the system prompt.
 *
 * Scopes are intentionally narrow — never sweep across tenants. A
 * sibling host may add an extra `namespace` axis for in-tenant
 * partitioning (e.g. `'preferences'` vs `'facts'`).
 */
export interface MemoryScope {
    tenantId: string
    principalId: string | null
    /** Optional sub-scope. Hosts that don't need it leave undefined. */
    namespace?: string
}

export interface MemoryRecord {
    id: string
    scope: MemoryScope
    /** The fact, free-form natural language. */
    fact: string
    /** Where the fact came from — usually a tool name or `'system'`. */
    source: string
    createdAt: Date
    updatedAt: Date
}

export interface MemoryStore {
    load(scope: MemoryScope): Promise<MemoryRecord[]>
    save(scope: MemoryScope, fact: string, source: string): Promise<MemoryRecord>
    forget(scope: MemoryScope, factId: string): Promise<void>
}
