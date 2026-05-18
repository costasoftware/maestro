import { defineAgentTool, err, ok } from '@costasoftware/maestro-core'
import { z } from 'zod'

import type { SupportBotCtx } from '../context'
import { tickets, type TicketSeverity } from '../data/tickets'

const inputSchema = z.object({
    ticketId: z.string().min(1).max(64),
    severity: z.enum(['low', 'med', 'high'] as const),
    note: z.string().max(500).optional(),
})

interface Output {
    id: string
    previousSeverity: TicketSeverity
    newSeverity: TicketSeverity
    escalatedAt: string
}

/**
 * Severity bump. Re-purposes the same mutation pattern as updateStatus
 * but on a different field — demonstrates the "many similar mutations"
 * shape that real products grow.
 */
export const escalateTool = defineAgentTool<typeof inputSchema, Output, SupportBotCtx>({
    name: 'escalate',
    description:
        'Raise (or lower) the severity of a ticket. Use HIGH for issues affecting paying customers in production. Use MED for blocked workflows. Use LOW for cosmetic or future-state issues. Returns NO_OP if the severity is unchanged.',
    transports: ['chat', 'mcp'],
    kind: 'write',
    costBand: 'cheap',
    inputSchema,
    execute: async (input, ctx) => {
        const ticket = tickets.get(input.ticketId)
        if (!ticket || ticket.workspaceId !== ctx.workspaceId) {
            return err('NOT_FOUND', `ticket ${input.ticketId} not found`)
        }
        if (ticket.severity === input.severity) {
            return err('NO_OP', `ticket ${input.ticketId} is already severity ${input.severity}`)
        }
        const previousSeverity = ticket.severity
        const escalatedAt = new Date()
        ticket.severity = input.severity
        ticket.history.push({
            at: escalatedAt,
            actor: ctx.actor === 'mcp-client' ? 'system' : 'agent',
            note: input.note ?? `severity changed from ${previousSeverity} to ${input.severity}`,
        })
        return ok({
            id: ticket.id,
            previousSeverity,
            newSeverity: input.severity,
            escalatedAt: escalatedAt.toISOString(),
        })
    },
})
