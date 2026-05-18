import { defineAgentTool, err, ok } from 'maestro-core'
import { z } from 'zod'

import type { SupportBotCtx } from '../context'
import { tickets } from '../data/tickets'

const inputSchema = z.object({
    ticketId: z.string().min(1).max(64),
})

interface Output {
    id: string
    subject: string
    summary: string
    historyCount: number
    lastUpdateAt: string
}

/**
 * Returns a synthetic paragraph the model can quote verbatim or rewrite.
 * The point is to show the kernel handling tool output that is plain
 * prose (no structured fields) — the model's job is to rephrase, not
 * to re-format.
 */
export const summariseTool = defineAgentTool<typeof inputSchema, Output, SupportBotCtx>({
    name: 'summarise',
    description:
        'Produce a short factual summary of a ticket including the subject, current status, severity, and the last few interactions. Useful when an agent wants to catch up on a ticket they have not seen before.',
    transports: ['chat', 'mcp'],
    kind: 'read',
    costBand: 'cheap',
    inputSchema,
    execute: async (input, ctx) => {
        const ticket = tickets.get(input.ticketId)
        if (!ticket || ticket.workspaceId !== ctx.workspaceId) {
            return err('NOT_FOUND', `ticket ${input.ticketId} not found`)
        }
        const last = ticket.history[ticket.history.length - 1]
        const lastUpdateAt = last ? last.at : ticket.openedAt
        const ageMin = Math.round((Date.now() - ticket.openedAt.getTime()) / 60000)
        const recent = ticket.history
            .slice(-3)
            .map((h) => `[${h.actor}] ${h.note}`)
            .join(' | ')
        const summary =
            `Ticket ${ticket.id} ("${ticket.subject}") was opened ${ageMin} minutes ago by ${ticket.customerEmail}. ` +
            `It is currently ${ticket.status} at severity ${ticket.severity}, with ${ticket.history.length} interactions. ` +
            `Most recent activity: ${recent}.`
        return ok({
            id: ticket.id,
            subject: ticket.subject,
            summary,
            historyCount: ticket.history.length,
            lastUpdateAt: lastUpdateAt.toISOString(),
        })
    },
})
