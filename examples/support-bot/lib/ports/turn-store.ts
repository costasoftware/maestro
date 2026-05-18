import type { TurnRecord, TurnStore } from '@costasoftware/maestro-core'

/**
 * In-memory turn store keyed by host-generated turn id. Each turn row
 * is upserted at least twice — once on dispatch (`status: 'pending'`),
 * once on completion (`status: 'completed' | 'failed' | 'aborted'`) —
 * so the contract is "last write wins per id".
 *
 * Production hosts back this with whatever table their schema dictates
 * (barbeiro uses a `HelpChatMessage` table with help-specific columns;
 * a generic host might use a single `chat_turns` table). The kernel
 * does not care — it only reads back `loadHistory` for prompt assembly.
 */
export class InMemoryTurnStore implements TurnStore {
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
