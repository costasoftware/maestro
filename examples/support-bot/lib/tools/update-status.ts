import { defineAgentTool, err, ok } from '@costasoftware/maestro-core'
import { z } from 'zod'

import type { SupportBotCtx } from '../context'
import { tickets, type TicketStatus } from '../data/tickets'

const inputSchema = z.object({
    ticketId: z.string().min(1).max(64),
    status: z.enum(['open', 'pending', 'resolved'] as const),
    note: z.string().max(500).optional(),
})

interface Output {
    id: string
    previousStatus: TicketStatus
    newStatus: TicketStatus
    transitionedAt: string
}

/**
 * Mutating tool. The kernel does not own write semantics — `kind: 'write'`
 * is metadata for admin dashboards and the host's audit log, not a
 * runtime gate. The actual permission check (workspace ownership) is
 * the tool body's job.
 *
 * In the support-bot example we keep mutations free — `actorScope` is
 * omitted because both `'agent'` and `'mcp-client'` are allowed to
 * change status. A real product would gate this with
 * `actorScope: ['agent']` to lock MCP clients out, or with
 * `requiresConfirmation: true` to force a preview-then-commit flow.
 */
export const updateStatusTool = defineAgentTool<typeof inputSchema, Output, SupportBotCtx>({
    name: 'updateStatus',
    description:
        'Change the status of a ticket to open / pending / resolved. Optionally attach a note to the history. Returns NOT_FOUND if the ticket is missing, NO_OP if the status is already what was requested.',
    transports: ['chat', 'mcp'],
    kind: 'write',
    costBand: 'cheap',
    inputSchema,
    execute: async (input, ctx) => {
        const ticket = tickets.get(input.ticketId)
        if (!ticket || ticket.workspaceId !== ctx.workspaceId) {
            return err('NOT_FOUND', `ticket ${input.ticketId} not found`)
        }
        if (ticket.status === input.status) {
            return err('NO_OP', `ticket ${input.ticketId} is already ${input.status}`)
        }
        const previousStatus = ticket.status
        const transitionedAt = new Date()
        ticket.status = input.status
        ticket.history.push({
            at: transitionedAt,
            actor: ctx.actor === 'mcp-client' ? 'system' : 'agent',
            note: input.note ?? `status changed from ${previousStatus} to ${input.status}`,
        })
        return ok({
            id: ticket.id,
            previousStatus,
            newStatus: input.status,
            transitionedAt: transitionedAt.toISOString(),
        })
    },
})
