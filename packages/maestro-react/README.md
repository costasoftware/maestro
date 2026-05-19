# maestro-react

React surface for the [Maestro](https://github.com/costasoftware/maestro) agent runtime.

## Status

`0.5.0-beta` — kernel-side API consolidation. Unifies the `bodyBuilder` signature across all three transports onto a single `BodyBuilderArgs` object shape; `httpSSETransport`'s legacy positional `(messages, metadata, attachments)` form still works but emits a one-time deprecation warning and is scheduled for removal in `1.0`. Wire format is unchanged — protocol stays at `0.2.0-beta`. The divergence was a v0.4 oversight surfaced by the first attachments consumer ([`Alfredao/trading-rag#2`](https://github.com/Alfredao/trading-rag/pull/2)) and called out in 0.4's adoption gotchas; v0.5 cleans it up before more consumers depend on the positional shape.

`0.4.0-beta` — additive release. Bumped `MaestroChatProtocol` to `0.2.0-beta` and closed GAP-1 surfaced by trading-rag's P4 adoption (`Alfredao/trading-rag#1`): the protocol now has a first-class slot for user-attached media. `send(text, { attachments: [...] })` stamps the attachments onto the user `MaestroMessage` AND forwards them to the transport — replacing the side-channel `Map<userMessageId, previewUrl>` workaround consumers were inventing per app. See [Sending attachments](#sending-attachments).

| Phase | Ships |
| --- | --- |
| P1 | `MaestroChatProtocol` types + `MAESTRO_CHAT_PROTOCOL.md` spec |
| P2 | `useMaestroChat()` hook + headless reducer + 3 transports (`httpSSETransport`, `aiSdkTransport`, `legacySseTransport`) |
| P3 | Composed UI primitives — `<ChatLauncher>` + `<ChatSheet>` + `<ChatPanel>` shell trio, plus building blocks (`<MessageList>`, `<MessageBubble>`, `<ChatInput>`, `<ToolCallCard>`, `<CitationCard>`). Pure CSS theming via custom properties; optional Tailwind preset. |
| P3.1 | `send(text, { metadata })` end-to-end, `setMessages` rehydration primitive, `regenerate()` last-user-turn replay. |
| **P3.2 (this release)** | Protocol `0.2.0-beta`: `MaestroAttachment` + `send(text, { attachments })` end-to-end, stamped on user messages and folded into the request body. |
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

`send(text, { metadata })` reaches the transport via `TransportSendArgs.metadata`. Built-in transports fold it into the default POST body as a top-level `metadata` field; if you pass a custom `bodyBuilder` it receives the metadata on `args.metadata` of the unified `BodyBuilderArgs` object (same shape for all three transports as of `0.5.0-beta`).

```tsx
const { send } = useMaestroChat({
    transport: httpSSETransport({
        url: '/api/chat',
        bodyBuilder: ({ messages, metadata }) => ({
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

### Sending attachments

`send(text, { attachments })` lands in `0.4.0-beta.0` (protocol `0.2.0-beta`). Attachments are uploaded out-of-band BEFORE you call `send` — the protocol does not specify the upload mechanism; pass the resulting durable URL into the `attachments` array. The hook stamps the attachments onto the user `MaestroMessage` (renderers can preview them via `message.attachments`) AND forwards them to the transport, which folds them into the POST body.

```tsx
import {
    useMaestroChat,
    httpSSETransport,
    type MaestroAttachment,
} from 'maestro-react'

async function uploadAndSend(file: File, prompt: string) {
    // 1. Upload bytes out-of-band — the protocol does not specify how.
    const uploaded = await uploadToYourBucket(file) // { url, mime, size }

    const attachment: MaestroAttachment = {
        kind: 'image',
        url: uploaded.url,
        mime: uploaded.mime,
        name: file.name,
        size: uploaded.size,
    }

    // 2. Send text + attachment in one call. The hook stamps the
    //    attachment onto the user MaestroMessage AND forwards it to
    //    the transport.
    await chat.send(prompt, { attachments: [attachment] })
}

// 3. Render previews from the user message.
{messages.map(m => (
    <div key={m.id}>
        {m.text}
        {m.attachments?.map(a => (
            <img key={a.url} src={a.url} alt={a.name ?? ''} />
        ))}
    </div>
))}
```

`MaestroAttachment` shape:

| Field | Required | Notes |
| --- | --- | --- |
| `kind` | yes | Open string. Common values: `'image'`, `'file'`, `'video'`, `'audio'`. |
| `url` | yes | Durable handle returned by the upload step. |
| `mime` | no | MIME type hint. Backend MAY infer. |
| `name` | no | Display name. |
| `size` | no | Byte count. |

Empty-text sends are permitted when `attachments` is non-empty — a pure-media turn (e.g. "here's an image, what is this?" with no caption) is a valid use case. The `text.trim().length === 0` short-circuit only fires when there are also no attachments.

Default request body produced by all three transports (`httpSSETransport`, `aiSdkTransport`, `legacySseTransport`):

```json
{
    "messages": [
        { "id": "msg_1", "role": "user", "text": "describe this", "attachments": [...] }
    ],
    "attachments": [...]
}
```

The top-level `attachments` mirrors the trailing user message's attachments. Backends SHOULD prefer the top-level field as the authoritative payload for the in-flight turn (one place to look, no walking `messages`). Custom `bodyBuilder`s receive `attachments` on `args.attachments` of the unified `BodyBuilderArgs` object (same shape for all three transports as of `0.5.0-beta`) so you can re-shape into any format your backend expects (e.g. AI SDK v6 `parts: [{ type: 'file', ... }]` per-message).

`regenerate()` re-uses the trailing user message's attachments by default. Pass `regenerate({ attachments: [] })` to retry without media (useful when an upload failed and the user wants to drop it).

#### Adoption gotchas

Surfaced by the first consumer adopting the canonical `attachments` field ([`Alfredao/trading-rag#2`](https://github.com/Alfredao/trading-rag/pull/2)) on top of the protocol bump ([`costasoftware/maestro#20`](https://github.com/costasoftware/maestro/pull/20)). Watch for these when wiring `0.4.0-beta` into an existing app.

-   **`bodyBuilder` is now unified across all three transports (`0.5.0-beta`).** Every transport receives the same `BodyBuilderArgs` object: `{ messages, metadata?, attachments? }`. Custom `bodyBuilder`s that don't fold `attachments` into your body shape still type-check (it's optional), but the default top-level fold only kicks in when no custom `bodyBuilder` is supplied. The legacy positional form on `httpSSETransport` from `0.4` still works for backwards compatibility — runtime dispatch detects it via `function.length`, calls it positionally, and emits a one-time `console.warn` per builder in non-production builds. The positional form is scheduled for removal in `1.0`; switch when you touch the file.

    ```ts
    // Recommended — unified shape, works for all three transports
    bodyBuilder: ({ messages, metadata, attachments }) => ({
        messages,
        attachments,
        ...(metadata as Record<string, unknown> | undefined),
    })

    // Still works on httpSSETransport (deprecated, removed in 1.0)
    bodyBuilder: (messages, metadata, attachments) => ({ messages, attachments })
    ```

-   **Two parallel handles can coexist.** The canonical `attachments` field is for protocol portability and UI preview. If your backend already has a fast dispatch handle for the file (filesystem key, internal ID), keep both — don't refactor the backend to use the canonical URL as its primary key. Forcing HTTP re-fetch instead of direct access is a real perf hit.

-   **Validator must allow empty text + attachments.** The protocol spec permits pure-media turns ("here's an image, what is this?"). Backends that previously required `message` non-empty must loosen to: text empty OR attachments non-empty. Otherwise the spec-permitted pure-media turn 422s.

    ```ts
    // Reject only when BOTH are empty.
    if (!text?.trim() && !attachments?.length) return 422
    ```

-   **`message.attachments?` is optional.** The field doesn't appear on assistant messages or on user messages without uploads. Renderers must guard with `message.attachments?.map(...)`, not `message.attachments.map(...)`. Soft gap to watch: history-rehydration loaders must explicitly stamp `attachments` when restoring saved threads — otherwise old uploads disappear on reload.

-   **`regenerate({})` re-uses trailing user attachments by default.** Matches the user-text reuse convention. To retry WITHOUT the failed upload, pass `regenerate({ attachments: [] })` explicitly. Easy to miss when wiring a "retry without media" UX.

    ```ts
    chat.regenerate({ attachments: [] }) // drop the failed media
    ```

-   **Lockfile bumps differ by package manager.** npm: `npm install` after the `package.json` bump suffices. pnpm: `pnpm install` plus a check of `pnpm-workspace.yaml` if the package gets resolved through a monorepo overlay.

## Transports

All three transports share the `Transport<TDataMap>` contract: a single `send({ messages, signal })` method returning `AsyncIterable<MaestroEvent>`. Pick one based on what your backend already speaks.

### `httpSSETransport` — protocol-native

For backends that emit `MaestroEvent` directly. One JSON-encoded event per SSE `data:` line.

```ts
import { httpSSETransport } from 'maestro-react'

const transport = httpSSETransport({
    url: '/api/chat',
    headers: () => ({ authorization: `Bearer ${getToken()}` }),
    bodyBuilder: ({ messages, metadata }) => ({
        thread: 'main',
        messages,
        metadata,
    }),
})
```

`bodyBuilder` receives the unified `BodyBuilderArgs` object: `{ messages, metadata?, attachments? }`. `metadata` is forwarded from `useMaestroChat#send(text, { metadata })`; `attachments` from `useMaestroChat#send(text, { attachments })`. Both are `undefined` when the caller did not supply them. The legacy positional form `(messages, metadata, attachments)` still works on this transport for backwards compatibility with `0.4.x` consumers but is deprecated and slated for removal in `1.0`.

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

A production-shape event map ships in `fixtures/`:

- [`fixtures/trading-rag-wire.ts`](./fixtures/trading-rag-wire.ts) — trading-rag's pre-P4 `token | agent_start | agent_step | agent_result | sources | chart_*` schema, including synthetic-tool-call pattern for agent pipelines. Trading-rag has since migrated to the native `MaestroChatProtocol` via `httpSSETransport` ([`Alfredao/trading-rag#1`](https://github.com/Alfredao/trading-rag/pull/1)); the fixture remains as the canonical worked example for the legacy-adapter shape.

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

Protocol version: `0.2.0-beta`. Locked after P4 (trading-rag native adoption) validates it against a non-TS implementation. Additive event additions ship as minor bumps; renames/removals are major. `0.2.0-beta` added the `attachments` field on user messages — see [`MAESTRO_CHAT_PROTOCOL.md` § User attachments](../../MAESTRO_CHAT_PROTOCOL.md#user-attachments).

## License

Apache-2.0
