import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { registerMcpTools } from 'maestro-core/adapters/mcp-server'

import { buildCtxFromHeaders } from '@/lib/auth'
import type { SupportBotCtx } from '@/lib/context'
import { supportBotPorts } from '@/lib/ports'
import { supportBotTools } from '@/lib/tools'

/**
 * MCP server endpoint at `/api/mcp`.
 *
 * Stateless Streamable HTTP transport — each request spins up a fresh
 * `McpServer` + transport, runs the JSON-RPC turn, returns the
 * response. The kernel's `registerMcpTools` adapter wires the same
 * tool registry that powers `/api/chat` onto the MCP server, so the
 * tool surface is identical across both transports.
 *
 * Filtering happens BEFORE `registerMcpTools` — we narrow to tools
 * that advertise `'mcp'` in their `transports` array. In this example
 * every tool advertises both surfaces; a production host with
 * surface-specific subsets would have a divergent list here.
 *
 * Auth: header-based mock (`x-support-bot-workspace`,
 * `x-support-bot-agent`). Real products would Bearer-token + OAuth
 * here (see barbeiro-app's `/api/mcp/route.ts` for the production
 * pattern with the `tokenAllowsTool` scope filter).
 */
export const runtime = 'nodejs'
export const maxDuration = 60

async function handle(request: Request): Promise<Response> {
    const ctx: SupportBotCtx = buildCtxFromHeaders({
        headers: request.headers,
        transport: 'mcp',
        actor: 'mcp-client',
        requestId: request.headers.get('mcp-request-id') ?? undefined,
    })

    const eligible = supportBotTools.filter((t) => t.transports.includes('mcp'))

    const server = new McpServer(
        { name: 'support-bot', version: '0.0.0' },
        { capabilities: { tools: {} } }
    )
    registerMcpTools<SupportBotCtx>({
        server,
        registry: eligible,
        ctx,
        audit: supportBotPorts.auditStore,
        onError: (error, tags) => {
            console.error('[mcp] tool execute threw', { error, tags })
        },
    })

    const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        // Plain JSON responses instead of SSE — single tool call → single
        // JSON reply, which is all we need for a stateless adapter and
        // avoids a Node 22 TransformStream bug observed in the wild on
        // the SSE path. See barbeiro-app's `/api/mcp` route for the
        // same workaround.
        enableJsonResponse: true,
    })
    await server.connect(transport)
    return transport.handleRequest(request)
}

export async function POST(request: Request): Promise<Response> {
    return handle(request)
}

export async function GET(request: Request): Promise<Response> {
    return handle(request)
}
