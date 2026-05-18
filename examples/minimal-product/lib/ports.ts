import {
    type AuditStore,
    type MemoryRecord,
    type MemoryScope,
    type MemoryStore,
    type ModelKeyProvider,
    type ModelProvider,
    NoopTelemetrySink,
    type QuotaState,
    type QuotaStore,
    type TelemetrySink,
    type ToolCallAudit,
    type TurnRecord,
    type TurnStore,
} from '@maestro/core'

/**
 * In-memory port implementations for the minimal example.
 *
 * Real products plug Prisma / Postgres / Redis / their own DBs in
 * here. The kernel does not care which storage backs each port; it
 * only depends on the interface. That's why ports exist instead of
 * the kernel embedding Prisma.
 *
 * These implementations are intentionally simple — process-local
 * Maps, no eviction, no concurrency control. Don't ship them.
 */

class InMemoryTurnStore implements TurnStore {
    private readonly turns = new Map<string, TurnRecord>()

    async upsert(turn: TurnRecord): Promise<void> {
        this.turns.set(turn.id, turn)
    }

    async loadHistory(threadId: string, limit?: number): Promise<TurnRecord[]> {
        const rows = Array.from(this.turns.values())
            .filter((t) => t.threadId === threadId)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        return typeof limit === 'number' ? rows.slice(-limit) : rows
    }

    async markFailed(turnId: string, error: { code: string; message: string }): Promise<void> {
        const existing = this.turns.get(turnId)
        if (!existing) return
        this.turns.set(turnId, { ...existing, status: 'failed', error, updatedAt: new Date() })
    }

    async markAborted(turnId: string, reason: string): Promise<void> {
        const existing = this.turns.get(turnId)
        if (!existing) return
        this.turns.set(turnId, {
            ...existing,
            status: 'aborted',
            error: { code: 'aborted', message: reason },
            updatedAt: new Date(),
        })
    }
}

class InMemoryAuditStore implements AuditStore {
    private readonly entries: ToolCallAudit[] = []

    async recordToolCall(audit: ToolCallAudit): Promise<void> {
        this.entries.push(audit)
    }

    /** Test helper, not part of the AuditStore contract. */
    list(): readonly ToolCallAudit[] {
        return this.entries
    }
}

class InMemoryMemoryStore implements MemoryStore {
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

class UnlimitedQuotaStore implements QuotaStore {
    async getCeilings(): Promise<Record<string, never>> {
        // No ceilings — example accepts anything.
        return {}
    }

    async check(query: { tenantId: string; surface: string }): Promise<QuotaState> {
        return {
            ceilings: {},
            used: { tokensIn: 0, tokensOut: 0, calls: 0, usdMicro: 0 },
            windowStart: new Date(0),
            windowEnd: new Date(8_640_000_000_000),
        }
    }

    async record(): Promise<void> {
        // No accounting — example is unlimited.
    }
}

function sameScope(a: MemoryScope, b: MemoryScope): boolean {
    return (
        a.tenantId === b.tenantId &&
        a.principalId === b.principalId &&
        (a.namespace ?? null) === (b.namespace ?? null)
    )
}

/**
 * Pulls Anthropic + OpenAI keys from `process.env`. Real products
 * read from their env / secret manager / per-tenant BYO-key table —
 * `tenantId` is intentionally unused here because this example uses
 * platform-wide keys.
 */
class EnvModelKeyProvider implements ModelKeyProvider {
    async getKey(provider: ModelProvider): Promise<string> {
        const envVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
        const key = process.env[envVar]
        if (!key) {
            throw new Error(
                `${envVar} is not configured. Copy .env.example to .env and add a key.`
            )
        }
        return key
    }
}

export const exampleTurnStore = new InMemoryTurnStore()
export const exampleAuditStore = new InMemoryAuditStore()
export const exampleMemoryStore = new InMemoryMemoryStore()
export const exampleQuotaStore = new UnlimitedQuotaStore()
export const exampleKeyProvider = new EnvModelKeyProvider()
export const exampleTelemetry: TelemetrySink = new NoopTelemetrySink()
