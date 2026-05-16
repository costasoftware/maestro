/**
 * Append-only log of individual tool calls. The kernel writes one row
 * per `execute` invocation (success, error, exception). Hosts use this
 * for governance, abuse review, and cost attribution rollups.
 *
 * `recordToolCall` may return before the row is durable — the kernel
 * calls it as fire-and-forget (`void store.recordToolCall(...)`) so a
 * slow audit write does not stall the chat turn.
 */
export interface ToolCallAudit {
    toolName: string
    transport: string
    actor: string
    tenantId: string
    principalId: string | null
    requestId: string | null
    /** Tool input as the model passed it. JSON-serializable. */
    input: unknown
    /** Compact result — full envelope payloads can be huge; the model output is in TurnStore. */
    output:
        | { ok: true }
        | { ok: false; code: string; message: string }
    durationMs: number
    createdAt: Date
}

export interface AuditStore {
    recordToolCall(audit: ToolCallAudit): Promise<void>
}
