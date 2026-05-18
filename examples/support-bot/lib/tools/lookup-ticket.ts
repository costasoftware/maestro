import { defineAgentTool, err, ok } from '@costasoftware/maestro-core'
import { z } from 'zod'

import type { SupportBotCtx } from '../context'
import { tickets, type Ticket } from '../data/tickets'

const inputSchema = z.object({
    ticketId: z.string().min(1).max(64).describe('The ticket id, e.g. TKT-001'),
})

interface Output {
    id: string
    subject: string
    status: Ticket['status']
    severity: Ticket['severity']
    customerEmail: string
    openedAt: string
    historyCount: number
}

/**
 * Read-only lookup. Demonstrates the most basic kernel shape: a
 * single-tool, two-branch envelope (`ok` / `err('NOT_FOUND', ...)`),
 * with the host's tenant scope (`ctx.workspaceId`) used to enforce
 * cross-tenant isolation. The kernel never sees the ticket data —
 * everything past `ctx` is the host's private domain.
 */
export const lookupTicketTool = defineAgentTool<typeof inputSchema, Output, SupportBotCtx>({
    name: 'lookupTicket',
    description:
        'Fetch the headline fields for a single support ticket by id. Returns NOT_FOUND if the ticket does not exist or belongs to another workspace.',
    transports: ['chat', 'mcp'],
    kind: 'read',
    costBand: 'cheap',
    inputSchema,
    execute: async (input, ctx) => {
        const ticket = tickets.get(input.ticketId)
        if (!ticket || ticket.workspaceId !== ctx.workspaceId) {
            return err('NOT_FOUND', `ticket ${input.ticketId} not found`)
        }
        return ok({
            id: ticket.id,
            subject: ticket.subject,
            status: ticket.status,
            severity: ticket.severity,
            customerEmail: ticket.customerEmail,
            openedAt: ticket.openedAt.toISOString(),
            historyCount: ticket.history.length,
        })
    },
})
