# maestro-react

React surface for the [Maestro](https://github.com/costasoftware/maestro) agent runtime.

## Status

`0.1.0-beta` — pre-release. P2 of a multi-phase rollout extracting React chat surfaces shared across multiple SaaS products with different backends (AI SDK v6, custom Node SSE, custom FastAPI SSE).

| Phase | Ships |
| --- | --- |
| P1 | `MaestroChatProtocol` types + `MAESTRO_CHAT_PROTOCOL.md` spec |
| **P2 (this release)** | `useMaestroChat()` hook + headless reducer + 3 transports (`httpSSETransport`, `aiSdkTransport`, `legacySseTransport`) |
| P3 | Shared UI primitives (tool cards, citation chips, progress affordances, composed surfaces) |
| P4 | Trading-rag native (FastAPI) adoption — validates the protocol against a non-TS implementation |

## Install

```bash
pnpm add maestro-react
```

Runtime deps in P2: none. `react` ≥ 18 is an OPTIONAL peer; `ai` ≥ 6 is an OPTIONAL peer used only by `aiSdkTransport`.

## Hooks

```tsx
import { useMaestroChat, httpSSETransport } from 'maestro-react'

function Chat() {
    const { messages, isLoading, error, send, abort } = useMaestroChat({
        transport: httpSSETransport({ url: '/api/chat' }),
        onFinish: final => console.log('done', final.text),
    })

    return (
        <>
            {messages.map(m => (
                <div key={m.id}>
                    <strong>{m.role}:</strong> {m.text}
                    {m.toolCalls.map(tc => (
                        <div key={tc.callId}>
                            tool {tc.name} → {tc.status}
                        </div>
                    ))}
                </div>
            ))}
            <button disabled={isLoading} onClick={() => send('hello')}>
                send
            </button>
            {isLoading && <button onClick={abort}>stop</button>}
            {error && <span>error: {error.message}</span>}
        </>
    )
}
```

### Typed `data` events

`useMaestroChat<TDataMap>` is generic over a host-supplied data registry. Pass a concrete interface to narrow `data[].value` by `data[].key`:

```ts
interface MyDataMap {
    'rag.quota': { remaining: number; limit: number }
    'chart.matches': { count: number }
}

const { messages } = useMaestroChat<MyDataMap>({
    transport: httpSSETransport<MyDataMap>({ url: '/api/chat' }),
})

for (const entry of messages.at(-1)?.data ?? []) {
    if (entry.key === 'rag.quota') {
        // entry.value: { remaining: number; limit: number }
        showQuota(entry.value.remaining)
    } else if (entry.key === 'chart.matches') {
        // entry.value: { count: number }
    }
}
```

Consumers who don't want types omit the generic — `data[].value` is `unknown`.

## Transports

All three transports share the `Transport<TDataMap>` contract: a single `send({ messages, signal })` method returning `AsyncIterable<MaestroEvent>`. Pick one based on what your backend already speaks.

### `httpSSETransport` — protocol-native

For backends that emit `MaestroEvent` directly. One JSON-encoded event per SSE `data:` line.

```ts
import { httpSSETransport } from 'maestro-react'

const transport = httpSSETransport({
    url: '/api/chat',
    headers: () => ({ authorization: `Bearer ${getToken()}` }),
    bodyBuilder: messages => ({ thread: 'main', messages }),
})
```

### `aiSdkTransport` — AI SDK v6 `UIMessageStream`

For Next.js apps using `createUIMessageStream` (barbeiro's pattern). Translates `text-delta`, `tool-input-available`, `tool-output-available`, `tool-output-error`, `data-citations`, `data-<custom>`, `error`, `finish` chunks into MaestroEvents.

```ts
import { aiSdkTransport } from 'maestro-react'

const transport = aiSdkTransport({
    url: '/api/help/chat',
    bodyBuilder: ({ messages }) => ({ id: threadId, messages }),
    // Custom data chip handlers (defaults handle `data-citations`):
    dataNameMapping: {
        'quota_warning': data => [
            { type: 'data', key: 'quota_warning', value: data },
        ],
    },
})
```

`ai` is an OPTIONAL peer dep — only declare it if you also build the backend.

### `legacySseTransport` — custom event names + eventMap

The killer adapter for adoption without backend changes. Pass an `eventMap` from your existing SSE event names → MaestroEvent translators. Mappers may return 0, 1, or N events.

```ts
import { legacySseTransport, type LegacyEventMap } from 'maestro-react'

const eventMap: LegacyEventMap<MyDataMap> = {
    text_delta: data => ({
        type: 'text-delta',
        delta: (data as { delta: string }).delta,
    }),
    tool_use: (data, ctx) => ({
        type: 'tool-call',
        callId: ctx.nextCallId(), // synthesise — legacy stream has no callId
        name: (data as { name: string }).name,
        input: (data as { input: unknown }).input,
    }),
    tool_result: (data, ctx) => ({
        type: 'tool-result',
        callId: ctx.lastCallId()!, // pair with the most recent tool_use
        result: (data as { result: unknown }).result,
    }),
    done: () => ({ type: 'done' }),
    error: data => ({
        type: 'error',
        message: (data as { message: string }).message,
    }),
}

const transport = legacySseTransport({
    url: '/v1/chat',
    eventMap,
    onUnknownEvent: name => console.warn('unmapped:', name),
})
```

Production-shape event maps for two real consumers ship in `fixtures/`:

- [`fixtures/numenion-wire.ts`](./fixtures/numenion-wire.ts) — numenion's `text_delta | tool_use | tool_result | error | done` schema
- [`fixtures/trading-rag-wire.ts`](./fixtures/trading-rag-wire.ts) — trading-rag's `token | agent_start | agent_step | agent_result | sources | chart_*` schema, including synthetic-tool-call pattern for agent pipelines

## Protocol

See [`src/protocol.ts`](./src/protocol.ts) for the TS union (authoritative for TS consumers) and the repo-root [`MAESTRO_CHAT_PROTOCOL.md`](../../MAESTRO_CHAT_PROTOCOL.md) for the language-neutral spec + Python reference helper.

Protocol version: `0.1.0-beta`. Locked after P4 (trading-rag native adoption) validates it against a non-TS implementation. Additive event additions ship as minor bumps; renames/removals are major.

## License

Apache-2.0
