/**
 * Mock ticket + knowledge-base store. Lives in-process so the example
 * has zero external deps beyond the Anthropic API key. All five tools
 * read from / mutate this `Map`.
 *
 * Real products would replace this with their domain database (a real
 * `Ticket` table, a real KB vector index). The kernel does not see any
 * of this layer — it is private to the tool bodies.
 */
export type TicketStatus = 'open' | 'pending' | 'resolved'
export type TicketSeverity = 'low' | 'med' | 'high'

export interface TicketHistoryEntry {
    at: Date
    actor: 'customer' | 'agent' | 'system'
    note: string
}

export interface Ticket {
    id: string
    workspaceId: string
    subject: string
    status: TicketStatus
    severity: TicketSeverity
    customerEmail: string
    openedAt: Date
    history: TicketHistoryEntry[]
}

const now = new Date()
const minutesAgo = (n: number): Date => new Date(now.getTime() - n * 60 * 1000)

const seed: Ticket[] = [
    {
        id: 'TKT-001',
        workspaceId: 'workspace_acme',
        subject: 'Cannot reset password — link expired immediately',
        status: 'open',
        severity: 'med',
        customerEmail: 'jane@acme.test',
        openedAt: minutesAgo(45),
        history: [
            { at: minutesAgo(45), actor: 'customer', note: 'I tried the reset link and got "expired" right after clicking.' },
            { at: minutesAgo(30), actor: 'agent', note: 'Confirmed link TTL is 15min; asked customer to retry.' },
            { at: minutesAgo(20), actor: 'customer', note: 'Tried again, same error. Using Safari on iOS.' },
        ],
    },
    {
        id: 'TKT-002',
        workspaceId: 'workspace_acme',
        subject: 'Billing — was charged twice for May invoice',
        status: 'pending',
        severity: 'high',
        customerEmail: 'finance@bigco.test',
        openedAt: minutesAgo(180),
        history: [
            { at: minutesAgo(180), actor: 'customer', note: 'Statement shows two $499 charges on May 3.' },
            { at: minutesAgo(150), actor: 'agent', note: 'Pulled gateway log — confirmed duplicate. Refund queued.' },
            { at: minutesAgo(120), actor: 'system', note: 'Refund initiated, awaiting bank confirmation (3-5 business days).' },
        ],
    },
    {
        id: 'TKT-003',
        workspaceId: 'workspace_acme',
        subject: 'API rate limit feels lower than the docs say',
        status: 'open',
        severity: 'low',
        customerEmail: 'dev@startup.test',
        openedAt: minutesAgo(20),
        history: [
            { at: minutesAgo(20), actor: 'customer', note: 'Docs say 100 req/s on the Pro plan but I am getting 429s at ~60 req/s.' },
        ],
    },
    {
        id: 'TKT-004',
        workspaceId: 'workspace_globex',
        subject: 'SAML metadata XML is rejected by your IdP form',
        status: 'resolved',
        severity: 'med',
        customerEmail: 'it@globex.test',
        openedAt: minutesAgo(720),
        history: [
            { at: minutesAgo(720), actor: 'customer', note: 'Upload form returns "invalid metadata".' },
            { at: minutesAgo(700), actor: 'agent', note: 'Found stray BOM in their XML, asked to re-export.' },
            { at: minutesAgo(680), actor: 'customer', note: 'Re-exported, works now. Thanks!' },
            { at: minutesAgo(670), actor: 'agent', note: 'Resolved.' },
        ],
    },
    {
        id: 'TKT-005',
        workspaceId: 'workspace_globex',
        subject: 'Webhooks dropping silently around midnight UTC',
        status: 'open',
        severity: 'high',
        customerEmail: 'ops@globex.test',
        openedAt: minutesAgo(60),
        history: [
            { at: minutesAgo(60), actor: 'customer', note: 'Around 00:00 UTC we get zero webhook deliveries for ~3min. Repeats nightly.' },
            { at: minutesAgo(40), actor: 'agent', note: 'Suspect ledger rollover. Escalated to platform team.' },
        ],
    },
]

export const tickets = new Map<string, Ticket>(seed.map((t) => [t.id, t]))

/**
 * Mock KB articles. The `searchKb` tool does a trivial substring match
 * — a real KB would be a vector store or a search index.
 */
export interface KbArticle {
    slug: string
    title: string
    snippet: string
}

export const kbArticles: KbArticle[] = [
    {
        slug: 'reset-password-troubleshooting',
        title: 'Reset password link expired immediately',
        snippet: 'Safari iOS pre-fetches links and consumes single-use tokens. Workaround: ask the customer to long-press the link and choose "Copy", then paste into the address bar.',
    },
    {
        slug: 'billing-duplicate-charge',
        title: 'Customer was charged twice for the same invoice',
        snippet: 'Duplicate-charge refunds clear in 3-5 business days. Confirm the gateway log shows two distinct charge ids; if only one, the customer is looking at a pending-vs-cleared duplication that will self-correct.',
    },
    {
        slug: 'api-rate-limits',
        title: 'API rate limits per plan tier',
        snippet: 'Documented rate limit is the per-region per-account ceiling. Burst limit is 60% of sustained — customers seeing 429 below the documented ceiling are usually hitting burst, not sustained.',
    },
    {
        slug: 'saml-metadata-bom',
        title: 'SAML metadata upload rejected — invalid XML',
        snippet: 'Most "invalid metadata" rejections are byte-order marks (BOM) left by Notepad / TextEdit. Ask the customer to re-export from their IdP and avoid editing the XML before upload.',
    },
    {
        slug: 'webhook-midnight-drop',
        title: 'Webhook deliveries pause around 00:00 UTC',
        snippet: 'Known issue with the ledger rollover job — webhook workers pause for up to 3 minutes during the daily ledger snapshot. Tracked in PLAT-2341, ETA next sprint.',
    },
]
