# minimal-product

Smallest possible Next.js 15 host that consumes [`@costasoftware/maestro-core`](https://www.npmjs.com/package/@costasoftware/maestro-core). Doubles as:

- **Onboarding template** — copy this and replace tools / ports with your own
- **Integration test surface** — when kernel ergonomics break in real-host context, they break here first

There is intentionally **no chat UI**. The integration is the API route. Hit it with `curl`.

## Run it

```bash
# from this directory
cp .env.example .env
# add ANTHROPIC_API_KEY to .env

# from the monorepo root
pnpm install
pnpm --filter @costasoftware/maestro-example-minimal-product dev
```

Open another terminal:

```bash
curl -N -X POST http://localhost:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "messages": [
      { "id": "1", "role": "user", "parts": [{ "type": "text", "text": "add 12 and 30" }] }
    ]
  }'
```

You should see the assistant call the `addNumbers` tool and stream the answer.

## What's wired

| Concept | File |
| --- | --- |
| Extended context | [`lib/context.ts`](./lib/context.ts) |
| Tools (3) | [`lib/tools.ts`](./lib/tools.ts) — `echo`, `addNumbers`, `getTime` |
| In-memory ports | [`lib/ports.ts`](./lib/ports.ts) — TurnStore, AuditStore, MemoryStore, QuotaStore, TelemetrySink |
| Chat endpoint | [`app/api/chat/route.ts`](./app/api/chat/route.ts) — `buildAiSdkTools` + `streamText` |

## What's NOT wired

- **No `runChatTurn`** — that's `@costasoftware/maestro-core@0.2.0` (P4). For now, the route hand-wires `streamText`.
- **No persistent storage** — ports are in-process Maps. Replace with Prisma / Postgres / Redis in your real product.
- **No quota enforcement** — `UnlimitedQuotaStore` accepts everything.
- **No prompt caching** — see `applyCacheBreakpoints` for the helper; not needed in a 3-tool demo.
- **No MCP server** — see `@costasoftware/maestro-core/adapters/mcp-server` for the parallel adapter.
- **No auth** — `principal` is hard-coded `demo-user`.

## License

Apache-2.0
