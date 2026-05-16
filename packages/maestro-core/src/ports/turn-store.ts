/**
 * Persists chat-turn rows. The kernel writes one row per user turn and
 * one per assistant turn, updates it as the turn completes, and reads
 * history when assembling the next prompt.
 *
 * Why this is a port (not direct Prisma):
 * - Each host has a different schema. Barbeiro's `HelpChatMessage` has
 *   help-specific fields (`surface`, `articleSlug`, `gap_reason`) a
 *   sibling product won't share. The port lets each host map
 *   `TurnRecord` → its own table.
 * - This is the test seam. Unit tests get an in-memory implementation;
 *   integration tests get a real DB. Prisma-direct = every test needs
 *   a DB up.
 */
export interface TurnRecord {
    /** Host-generated id (cuid/uuid). */
    id: string
    /** Thread the turn belongs to. */
    threadId: string
    /** Tenant scope (same as `BaseToolContext.tenantId`). */
    tenantId: string
    /** Conversation role. */
    role: 'user' | 'assistant' | 'system' | 'tool'
    /** JSON-serializable payload — host renders it. */
    content: unknown
    /** Turn lifecycle state. */
    status: 'pending' | 'completed' | 'failed' | 'aborted'

    /** Optional metering metadata (filled in by `runChatTurn`). */
    modelId?: string
    tokensIn?: number
    tokensOut?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    /** USD cost in micro-dollars (integer) — avoids float drift in aggregates. */
    costUsdMicro?: number
    durationMs?: number
    error?: { code: string; message: string }

    /** Host-attached extras. Kernel does not interpret. */
    metadata?: Record<string, unknown>

    createdAt: Date
    updatedAt: Date
}

export interface TurnStore {
    /**
     * Insert or update a turn by `id`. Called multiple times per turn:
     * once on dispatch (status=pending), once on completion or failure.
     */
    upsert(turn: TurnRecord): Promise<void>

    /** Recent history for prompt assembly, oldest-first. */
    loadHistory(threadId: string, limit?: number): Promise<TurnRecord[]>

    /** Terminal mark — kernel calls this when the model call rejects. */
    markFailed(turnId: string, error: { code: string; message: string }): Promise<void>

    /** Terminal mark — kernel calls this on abort signal. */
    markAborted(turnId: string, reason: string): Promise<void>
}
