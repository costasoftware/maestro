import type { AuditStore, ToolCallAudit } from 'maestro-core'

/**
 * Console-backed audit store — every tool call is logged as a single
 * structured line, then dropped. This is intentional for the example:
 * production hosts pipe to a real append-only log (Postgres table,
 * Loki, S3 + Athena), but for kernel-validation purposes the only
 * requirement is "the port is invoked with the right shape".
 *
 * The kernel calls `recordToolCall` as fire-and-forget so a slow audit
 * write never stalls the chat turn — implementations can return before
 * the row is durable.
 */
export class ConsoleAuditStore implements AuditStore {
    async recordToolCall(audit: ToolCallAudit): Promise<void> {
        const outcome = audit.output.ok
            ? 'ok'
            : `err:${audit.output.code}`
        console.info(
            `[audit] tool=${audit.toolName} transport=${audit.transport} actor=${audit.actor} tenant=${audit.tenantId} principal=${audit.principalId ?? '-'} duration=${audit.durationMs}ms outcome=${outcome}`
        )
    }
}
