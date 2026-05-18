# support-bot

Second example product in the maestro monorepo. Its job is to **prove the kernel generalises** beyond the shape that `barbeiro-app` (the original consumer) imposed — different transports, tenant model, ports, locale story, and auth.

If `minimal-product` answers "can the kernel run at all?", this answers "can the kernel run somewhere else?".

## What this is

A simplified customer-support bot for a B2B SaaS — five tools, two transports (browser chat + MCP), workspace-scoped multi-tenancy, all in-process state. No database, no Redis, no i18n.

## Shape vs the two other host examples

| Concern        | `barbeiro-app` (production)                       | `support-bot` (this)                       | `minimal-product`                  |
| -------------- | ------------------------------------------------- | ------------------------------------------ | ---------------------------------- |
| Tenant model   | numeric `business.id`                             | string `workspace_<n>`                     | single hard-coded workspace        |
| Transports     | `chat`, `guest-chat`, `whatsapp`, `mcp`           | `chat`, `mcp`                              | `chat`, `mcp` (declared, only chat wired) |
| Memory store   | Prisma table                                       | `Map<string, MemoryRecord>`                | `Map<string, MemoryRecord>`        |
| Quota store    | Prisma + Redis sliding-window                      | in-memory call counter                     | unlimited (no-op)                  |
| Audit store    | Prisma `ToolCallAudit` table                       | `console.info` per call                    | array of records (test seam)       |
| Telemetry      | maestro-plane / Sentry                             | `console.info` per event                   | `NoopTelemetrySink`                |
| Tool count     | 93                                                | 5                                          | 3                                  |
| Surface set    | `'admin' \| 'customer' \| 'help-public' \| 'landing'` (mapped) | `'agent' \| 'mcp-client'` (actor only) | `'demo-user'` actor                |
| Locale         | next-intl, 3 locales                               | hard-coded `en-US`                         | hard-coded `en-US`                 |
| Auth           | better-auth + OAuth2 + scoped MCP tokens          | header-based mock                          | none                               |

Same `@maestro/core` package backs all three — the variability lives entirely in the host's ctx, ports, and route handlers.

## Layout

```
examples/support-bot/
  app/
    layout.tsx
    page.tsx                -- vanilla-fetch chat UI
    api/
      chat/route.ts         -- runChatTurn (writer-arg path)
      mcp/route.ts          -- MCP server adapter
  lib/
    context.ts              -- SupportBotCtx extends BaseToolContext<'chat' | 'mcp'>
    auth.ts                 -- buildCtxFromHeaders (mock auth)
    data/tickets.ts         -- in-memory ticket + KB seed data
    ports/
      turn-store.ts         -- InMemoryTurnStore
      memory-store.ts       -- InMemoryMemoryStore
      quota-store.ts        -- InMemoryQuotaStore (with a real ceiling)
      audit-store.ts        -- ConsoleAuditStore
      key-provider.ts       -- EnvKeyProvider
      telemetry-sink.ts     -- ConsoleTelemetrySink
      index.ts              -- supportBotPorts bundle
    tools/
      lookup-ticket.ts
      update-status.ts
      search-kb.ts
      escalate.ts
      summarise.ts
      index.ts              -- supportBotTools registry
```

## The kernel's port surface

The kernel does not embed Prisma, Redis, Sentry, or any other infra. It depends on six small interfaces and one optional clock — every product wires its own implementation. This example wires the simplest legitimate option for each port:

| Port              | What it does                                                              | This example's impl                           | Why this shape                                                       |
| ----------------- | ------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| `TurnStore`       | Persist user + assistant turn rows for prompt assembly + cost lookup      | `Map<id, TurnRecord>` keyed by host-generated id | Process-local is enough for a single-process demo; the kernel only needs upsert + loadHistory |
| `MemoryStore`     | Per-principal facts that travel between threads in the same tenant       | `Map<id, MemoryRecord>` filtered by scope     | Memory is optional; the example wires it to demonstrate the scope shape |
| `QuotaStore`      | Per-tenant call/token/cost ceilings                                       | `Map<tenant, count>` + fixed 500-call ceiling | Real ceilings without Redis — shows the kernel's `AiQuotaDeniedError` path when you exceed |
| `AuditStore`      | Append-only log of every tool call                                        | `console.info`                                | We do not need durability for a demo; structured log is enough to verify the port fires |
| `ModelKeyProvider`| Resolve the Anthropic/OpenAI key for a tenant                             | `process.env.ANTHROPIC_API_KEY`               | Single platform key, no BYO; the `tenantId` arg is unused            |
| `TelemetrySink`   | Best-effort events (`turn.finalized`, `quota.consumed`, etc.)             | `console.info` per event                      | Lets you see the kernel's events flow against the dev server log     |

Compare to barbeiro's production wiring (Prisma for `TurnStore` / `AuditStore` / `MemoryStore`, Postgres + Redis for `QuotaStore`, secret-manager for `ModelKeyProvider`, maestro-plane for `TelemetrySink`). The kernel call signature is identical.

## The transport-narrowing trap (closed)

The kernel's `BaseToolContext<TTransport extends string = string>` defaults to `string` — a transport string can be any string, and `defineAgentTool({ transports: [...] })` literals are unchecked. That is convenient for the kernel's own tests but a footgun for hosts: a mis-routed surface, a typo, or a stale literal can silently produce an empty registry, and Anthropic with `tools: {}` falls back to emitting `<function_calls>` XML in prose (this is trap #4 in the kernel README).

Narrowing the generic closes it structurally:

```ts
// lib/context.ts
export type SupportBotTransport = 'chat' | 'mcp'
export interface SupportBotCtx extends BaseToolContext<SupportBotTransport> {
    workspaceId: string
    workspaceName: string
}
```

Now:

- Every `defineAgentTool<TInput, TOutput, SupportBotCtx>` literal is checked: `transports: ['admin']` fails to compile because `'admin'` is not in `SupportBotTransport`.
- Every ctx-construction site (`buildCtxFromHeaders`, both route handlers) is checked: `transport: 'chta'` fails to compile.
- No `as never` cast can rescue a bad literal — the typo surfaces in the IDE, not at runtime.

PR #4 (`feat(core)!: tighten BaseToolContext.transport to a generic union`) shipped exactly this generalisation in `maestro-core@0.3.0`. This example is what it looks like when a host actually opts in.

## Run it locally

```bash
# from the monorepo root
pnpm install

# add ANTHROPIC_API_KEY to the example's .env
cp examples/support-bot/.env.example examples/support-bot/.env
$EDITOR examples/support-bot/.env

# dev server on port 3001 (minimal-product is on 3000)
pnpm --filter @maestro/example-support-bot dev
```

Open `http://localhost:3001` for the chat UI. The console will stream `[audit] tool=...` and `[telemetry] turn.finalized ...` lines as you interact.

### curl chat

```bash
curl -N -X POST http://localhost:3001/api/chat \
  -H 'content-type: application/json' \
  -H 'x-support-bot-workspace: workspace_acme' \
  -d '{
    "messages": [
      { "id": "1", "role": "user",
        "parts": [{ "type": "text", "text": "summarise TKT-001 and suggest a KB article" }] }
    ]
  }'
```

### MCP from Claude Desktop / Cursor

Add to your MCP client config (Claude Desktop's `claude_desktop_config.json` or Cursor's MCP settings):

```jsonc
{
    "mcpServers": {
        "support-bot": {
            "transport": "http",
            "url": "http://localhost:3001/api/mcp",
            "headers": {
                "x-support-bot-workspace": "workspace_acme",
                "x-support-bot-agent": "agent_demo"
            }
        }
    }
}
```

Claude Desktop / Cursor will discover all five tools and call them with the workspace scope you set. Tools that take a ticket id will be scoped to `workspace_acme` — passing a ticket id from `workspace_globex` (e.g. `TKT-005`) returns `NOT_FOUND`, demonstrating the cross-tenant isolation enforced by the tool body, not the kernel.

## Adding a sixth tool

The whole point of the kernel's tool factory is that a new tool is one file:

1. Write `examples/support-bot/lib/tools/my-new-tool.ts`:

    ```ts
    import { defineAgentTool, err, ok } from '@maestro/core'
    import { z } from 'zod'
    import type { SupportBotCtx } from '../context'

    const inputSchema = z.object({
        ticketId: z.string().min(1).max(64),
    })

    export const myNewTool = defineAgentTool<typeof inputSchema, { acknowledged: true }, SupportBotCtx>({
        name: 'myNewTool',
        description: 'What it does, and crucially, WHEN to call it vs not.',
        transports: ['chat', 'mcp'],
        kind: 'write',
        costBand: 'cheap',
        inputSchema,
        execute: async (_input, _ctx) => ok({ acknowledged: true }),
    })
    ```

2. Add it to the registry in `lib/tools/index.ts`:

    ```diff
     export const supportBotTools = [
         lookupTicketTool,
         updateStatusTool,
         searchKbTool,
         escalateTool,
         summariseTool,
    +    myNewTool,
     ] as const
    ```

3. Restart the dev server. The new tool appears on both the chat route AND the MCP server (no per-transport registration). Claude Desktop will pick it up on the next `tools/list` call.

That is the whole migration story. The kernel does not need a manifest update, an admin sync, or a schema migration — the only place that knows about the tool is the registry array.

## What this example deliberately skips

- **No `@ai-sdk/react`** — the chat UI is a vanilla fetch + SSE reader, ~50 LoC. Real products with rich tool-call rendering would use `useChat` or roll their own primitives.
- **No real auth** — header-based mock. See `barbeiro-app`'s `/api/oauth/token` + Bearer token flow for a production MCP auth example.
- **No persistent storage** — ports are in-process Maps. State resets every dev server restart.
- **No i18n** — locale is hard-coded `'en-US'`. Adding next-intl is orthogonal to the kernel.
- **No prompt-cache verification** — the kernel applies cache breakpoints, but a 5-tool demo will never benefit meaningfully. The smoke-test from the kernel README (`cache_write_tokens > 0` on cold first turn) still applies and is visible in the `[telemetry] turn.finalized` log line.

## License

Apache-2.0
