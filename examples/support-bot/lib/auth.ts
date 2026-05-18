import type { SupportBotActor, SupportBotCtx, SupportBotTransport } from './context'

/**
 * Tiny header-based mock auth. Two headers:
 *   - `x-support-bot-workspace` — string workspace id (defaults to
 *     `workspace_acme` so the curl examples in the README work).
 *   - `x-support-bot-agent`     — agent id (defaults to `agent_demo`).
 *
 * Real products replace this with whatever their auth layer ships
 * (better-auth session cookies, JWT bearer tokens, OAuth2). The
 * kernel does not care — `principal` and `tenantId` are opaque to it.
 */
const DEFAULT_WORKSPACE_ID = 'workspace_acme'
const DEFAULT_WORKSPACE_NAME = 'Acme Inc'
const DEFAULT_AGENT_ID = 'agent_demo'

const workspaceNames: Record<string, string> = {
    workspace_acme: 'Acme Inc',
    workspace_globex: 'Globex Corporation',
}

export interface AuthedRequestArgs {
    headers: Headers
    transport: SupportBotTransport
    actor: SupportBotActor
    requestId?: string
}

export function buildCtxFromHeaders(args: AuthedRequestArgs): SupportBotCtx {
    const workspaceId = args.headers.get('x-support-bot-workspace') ?? DEFAULT_WORKSPACE_ID
    const principalId = args.headers.get('x-support-bot-agent') ?? DEFAULT_AGENT_ID
    const workspaceName = workspaceNames[workspaceId] ?? workspaceId

    return {
        tenantId: workspaceId,
        principal: {
            id: principalId,
            kind: args.actor === 'mcp-client' ? 'mcp-client' : 'agent',
        },
        actor: args.actor,
        transport: args.transport,
        locale: 'en-US',
        timezone: 'UTC',
        requestId: args.requestId ?? `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        workspaceId,
        workspaceName,
    }
}
