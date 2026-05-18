import { defineAgentTool, ok } from 'maestro-core'
import { z } from 'zod'

import type { SupportBotCtx } from '../context'
import { kbArticles, type KbArticle } from '../data/tickets'

const inputSchema = z.object({
    query: z.string().min(2).max(200),
    limit: z.number().int().min(1).max(10).optional(),
})

interface Output {
    query: string
    results: KbArticle[]
}

/**
 * Knowledge-base lookup. Always returns `ok` (an empty result list is
 * a legitimate outcome, not an error). Demonstrates the case where
 * the kernel's `ToolEnvelope` failure branch is correctly NOT used —
 * "no matches" is data, not an error condition.
 */
export const searchKbTool = defineAgentTool<typeof inputSchema, Output, SupportBotCtx>({
    name: 'searchKb',
    description:
        'Search the knowledge base for articles matching a natural-language query. Returns at most `limit` results (default 3). An empty result list is a successful response, not an error.',
    transports: ['chat', 'mcp'],
    kind: 'read',
    costBand: 'cheap',
    inputSchema,
    execute: async (input) => {
        const needle = input.query.toLowerCase()
        const limit = input.limit ?? 3
        const results = kbArticles
            .filter((a) => a.title.toLowerCase().includes(needle) || a.snippet.toLowerCase().includes(needle))
            .slice(0, limit)
        return ok({ query: input.query, results })
    },
})
