import type { MemoryRecord, MemoryScope, MemoryStore } from '@maestro/core'

/**
 * Process-local memory store. Keyed by record id; lookups filter by
 * scope (tenant + principal + optional namespace).
 *
 * Production hosts back this with a `MemoryFact` table or a vector
 * store; the kernel only reads via `load(scope)` and writes via
 * `save(scope, fact, source)`. Scopes never cross tenants.
 */
export class InMemoryMemoryStore implements MemoryStore {
    private readonly records = new Map<string, MemoryRecord>()
    private nextId = 0

    async load(scope: MemoryScope): Promise<MemoryRecord[]> {
        return Array.from(this.records.values()).filter((r) => sameScope(r.scope, scope))
    }

    async save(scope: MemoryScope, fact: string, source: string): Promise<MemoryRecord> {
        const id = `mem_${++this.nextId}`
        const now = new Date()
        const record: MemoryRecord = { id, scope, fact, source, createdAt: now, updatedAt: now }
        this.records.set(id, record)
        return record
    }

    async forget(_scope: MemoryScope, factId: string): Promise<void> {
        this.records.delete(factId)
    }
}

function sameScope(a: MemoryScope, b: MemoryScope): boolean {
    return (
        a.tenantId === b.tenantId &&
        a.principalId === b.principalId &&
        (a.namespace ?? null) === (b.namespace ?? null)
    )
}
