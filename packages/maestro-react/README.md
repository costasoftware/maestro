# maestro-react

React surface for the [Maestro](https://github.com/costasoftware/maestro) agent runtime.

## Status

`0.3.0-beta` — additive release. Closes three API gaps surfaced by barbeiro's adoption (`barbeiro-app#403`): `send(text, { metadata })` now actually reaches the transport, `setMessages` rehydrates a saved thread without aborting in-flight streams, and `regenerate()` re-runs the last user turn without the `reset() + N×append()` dance. Protocol unchanged (`0.1.0-beta`); no breaking changes from `0.2.0-beta`.

| Phase | Ships |
| --- | --- |
| P1 | `MaestroChatProtocol` types + `MAESTRO_CHAT_PROTOCOL.md` spec |
| P2 | `useMaestroChat()` hook + headless reducer + 3 transports (`httpSSETransport`, `aiSdkTransport`, `legacySseTransport`) |
| P3 | Composed UI primitives — `<ChatLauncher>` + `<ChatSheet>` + `<ChatPanel>` shell trio, plus building blocks (`<MessageList>`, `<MessageBubble>`, `<ChatInput>`, `<ToolCallCard>`, `<CitationCard>`). Pure CSS theming via custom properties; optional Tailwind preset. |
| **P3.1 (this release)** | `send(text, { metadata })` end-to-end, `setMessages` rehydration primitive, `regenerate()` last-user-turn replay. |
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

### Send-time metadata

`send(text, { metadata })` reaches the transport via `TransportSendArgs.metadata`. Built-in transports fold it into the default POST body as a top-level `metadata` field; if you pass a custom `bodyBuilder` it receives the metadata too — as the second argument for `httpSSETransport`, as `args.metadata` for `aiSdkTransport` and `legacySseTransport`.

```tsx
const { send } = useMaestroChat({
    transport: httpSSETransport({
        url: '/api/chat',
        bodyBuilder: (messages, metadata) => ({
            messages,
            // Per-turn envelope — request id, surface, idempotency key, …
            ...(metadata as Record<string, unknown> | undefined),
        }),
    }),
})

await send('what changed yesterday?', {
    metadata: { requestId: crypto.randomUUID(), surface: 'admin' },
})
```

Metadata is per-send, not per-message — it never persists on `MaestroMessage`. Use `append()` or rehydration if you need to keep the value around.

### Thread rehydration via `setMessages`

`setMessages(next)` replaces the message list wholesale. It deliberately does NOT abort the in-flight `AbortController`, does NOT clear `error`, and does NOT toggle `isLoading` — load a saved conversation while a different stream is mid-flight and the stream keeps going.

```tsx
const { messages, setMessages } = useMaestroChat({ transport })

useEffect(() => {
    let cancelled = false
    void fetch(`/api/threads/${threadId}`)
        .then(r => r.json() as Promise<MaestroMessage[]>)
        .then(history => {
            if (!cancelled) setMessages(history)
        })
    return () => {
        cancelled = true
    }
}, [threadId, setMessages])
```

Use `reset()` instead when you want a full state wipe (clears messages back to `initialMessages`, aborts in-flight stream, clears error, clears `isLoading`).

### Regenerate the last turn

`regenerate({ metadata })` trims everything after the most recent user message and re-runs the transport against the trimmed history. The user message stays — only the stale assistant turn drops. If there is no user message in `messages`, it no-ops and logs a `console.warn`.

```tsx
const { regenerate, messages, isLoading } = useMaestroChat({ transport })

return (
    <button
        disabled={isLoading || messages.length === 0}
        onClick={() => regenerate({ metadata: { reason: 'user-retry' } })}
    >
        Retry last answer
    </button>
)
```

Like `send()`, `regenerate()` aborts any in-flight stream before starting the new one — two simultaneous streams would race. The new run uses a fresh `AbortController`.

## Transports

All three transports share the `Transport<TDataMap>` contract: a single `send({ messages, signal })` method returning `AsyncIterable<MaestroEvent>`. Pick one based on what your backend already speaks.

### `httpSSETransport` — protocol-native

For backends that emit `MaestroEvent` directly. One JSON-encoded event per SSE `data:` line.

```ts
import { httpSSETransport } from 'maestro-react'

const transport = httpSSETransport({
    url: '/api/chat',
    headers: () => ({ authorization: `Bearer ${getToken()}` }),
    bodyBuilder: (messages, metadata) => ({ thread: 'main', messages, metadata }),
})
```

`metadata` is the optional second argument passed by `useMaestroChat#send(text, { metadata })`. It is `undefined` when the caller did not supply any.

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

## Components

Three top-level shell components compose into either a **bubble** (FAB → slide-in sheet) or a **page** (full-height) chat surface. There is no `mode` prop — composition is the choice.

Drop the canonical CSS in once:

```ts
// Anywhere that runs at app boot (Next.js `app/layout.tsx`, Vite `main.tsx`, etc.)
import 'maestro-react/styles.css'
```

### Bubble mode (8 lines of JSX)

```tsx
import { useState } from 'react'
import {
    ChatLauncher,
    ChatPanel,
    ChatSheet,
    httpSSETransport,
    useMaestroChat,
} from 'maestro-react'

function SupportBubble() {
    const [open, setOpen] = useState(false)
    const chat = useMaestroChat({ transport: httpSSETransport({ url: '/api/chat' }) })
    return (
        <>
            <ChatLauncher onOpen={() => setOpen(true)} />
            <ChatSheet open={open} onClose={() => setOpen(false)} title="Support">
                <ChatPanel chat={chat} placeholder="Ask anything..." />
            </ChatSheet>
        </>
    )
}
```

### Page mode (4 lines of JSX)

```tsx
import { ChatPanel, httpSSETransport, useMaestroChat } from 'maestro-react'

function ChatPage() {
    const chat = useMaestroChat({ transport: httpSSETransport({ url: '/api/chat' }) })
    return <ChatPanel chat={chat} placeholder="Ask anything..." />
}
```

### Typed data renderers

`<ChatPanel>` (and `<MessageBubble>`, `<MessageList>`) accept a typed `dataRenderers` registry. Pass the same `TDataMap` you used with `useMaestroChat` and the renderer's `value` prop is narrow per key:

```tsx
import {
    ChatPanel,
    type DataRendererRegistry,
    useMaestroChat,
} from 'maestro-react'

interface SupportDataMap {
    'ticket.summary': { id: string; title: string; status: 'open' | 'closed' }
    'quota.warning': { remaining: number; limit: number }
}

const dataRenderers: DataRendererRegistry<SupportDataMap> = {
    'ticket.summary': ({ value }) => (
        <article className="ticket-card">
            <strong>{value.id}</strong> — {value.title} <em>({value.status})</em>
        </article>
    ),
    'quota.warning': ({ value }) => (
        <p>{value.remaining} of {value.limit} calls remaining</p>
    ),
}

function Page() {
    const chat = useMaestroChat<SupportDataMap>({ transport })
    return <ChatPanel chat={chat} dataRenderers={dataRenderers} />
}
```

Unknown keys fall back to a `<pre>` JSON dump so no event silently disappears.

### Override renderers for tool calls + citations

```tsx
<ChatPanel
    chat={chat}
    renderToolCall={call =>
        call.name === 'lookupTicket' ? <TicketLookupCard call={call} /> : <ToolCallCard call={call} />
    }
    renderCitation={citation => <BrandedCitation citation={citation} />}
/>
```

### Theming — CSS variables

Override on `:root`, a wrapper, or any ancestor:

```css
.brand-theme {
    --maestro-accent-bg: #16a34a;
    --maestro-accent-bg-hover: #15803d;
    --maestro-bubble-bg: #f8fafc;
    --maestro-bubble-user-bg: var(--maestro-accent-bg);
    --maestro-sheet-width: 480px;
    --maestro-launcher-size: 64px;
}
```

A Tailwind preset is shipped separately if you'd rather scope the CSS into a Tailwind `@layer components` — `import 'maestro-react/tailwind'` after your Tailwind imports.

### Building blocks

When the composed shells aren't enough, the underlying primitives are exported individually: `<MessageList>`, `<MessageBubble>`, `<ChatInput>`, `<ToolCallCard>`, `<CitationCard>`, plus the `useAutoScroll` hook. Mix them with your own layout — the `<ChatPanel>` source is the reference assembly.

## Protocol

See [`src/protocol.ts`](./src/protocol.ts) for the TS union (authoritative for TS consumers) and the repo-root [`MAESTRO_CHAT_PROTOCOL.md`](../../MAESTRO_CHAT_PROTOCOL.md) for the language-neutral spec + Python reference helper.

Protocol version: `0.1.0-beta`. Locked after P4 (trading-rag native adoption) validates it against a non-TS implementation. Additive event additions ship as minor bumps; renames/removals are major.

## License

Apache-2.0
