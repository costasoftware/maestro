/**
 * MaestroChatProtocol — wire-format-neutral event vocabulary for chat
 * surfaces built on top of streaming LLM backends.
 *
 * Version: 0.2.0-beta. The shape is locked only after a non-TypeScript
 * backend (trading-rag, FastAPI) implements it natively as part of P4.
 * Until then, additions are permitted; renames/removals are not.
 *
 * The language-neutral specification lives at the repo root:
 *   `MAESTRO_CHAT_PROTOCOL.md`
 *
 * The TS union below IS the spec for TS consumers. Backends that adopt
 * the protocol natively MUST emit one event per SSE `data:` line, JSON-
 * encoded, with the `type` discriminator at the top level.
 *
 * ─────────────────────────────────────────────────────────────────────
 * DESIGN DECISIONS (locked for 0.1.0-beta)
 * ─────────────────────────────────────────────────────────────────────
 *
 * D1. `callId` discipline
 *   - REQUIRED on every tool-* event (`tool-call`, `tool-progress`,
 *     `tool-result`). Without it, consumers cannot correlate streaming
 *     progress to the originating call, and concurrent tool calls (a
 *     deliberately allowed extension point) become unrenderable.
 *   - OPTIONAL on `citation` and `data`. These events are often
 *     turn-scoped (a final list of sources, a top-level rate-limit
 *     warning) rather than tool-scoped. When they ARE tool-scoped,
 *     emitters SHOULD set `callId` so UIs can attach them to the
 *     corresponding tool card.
 *
 * D2. `tool-progress` is first-class (not folded into `data`)
 *   - Progress events have a known UX rendering (status chip / spinner
 *     / inline updating text) that differs from arbitrary data
 *     attachments. Trading-rag's `agent_step` and numenion's
 *     incremental tool messaging both map cleanly onto this shape.
 *   - Keeping it separate means a default chat UI can render progress
 *     without knowing any backend-specific keys.
 *
 * D3. `citation` is first-class (not folded into `data`)
 *   - Both barbeiro (`data-citations`) and trading-rag (`sources`)
 *     emit citations and benefit from a canonical inline-source card
 *     in the UI. Forcing this through `data` would require every
 *     consumer to learn a magic key, defeating the protocol's
 *     promise of a default rendering layer.
 *
 * D4. `done.text` is optional and informational
 *   - The final assistant text MUST be reconstructable from the
 *     stream of `text-delta` events alone. `done.text` exists only
 *     as a convenience for backends that want to restate the
 *     canonical final message (useful when `text-delta` chunking
 *     was irregular, or when the backend buffered + re-emitted).
 *   - Consumers MUST NOT depend on `done.text` being present.
 *
 * D5. One `done` per POST in v0.1
 *   - A single POST produces exactly one `done`. Multi-message-per-
 *     POST flows (trading-rag has cases that semantically yield
 *     intro → tool call → summary as three messages) are an OPEN
 *     QUESTION resolved in P4 during trading-rag adoption.
 *   - Until then, backends with multi-message flows MUST collapse
 *     them into a single assistant turn (text-delta + tool-* +
 *     text-delta + done), OR open multiple POSTs.
 *   - A future `turn-boundary` event is a candidate but not in v0.1.
 *
 * ─────────────────────────────────────────────────────────────────────
 * EXTENSION RULES
 * ─────────────────────────────────────────────────────────────────────
 *
 * - DO NOT add a new top-level event type without a minor version bump
 *   AND a parallel update to `MAESTRO_CHAT_PROTOCOL.md`.
 * - DO use `data` with a backend-namespaced `key` for app-specific
 *   events (e.g. `chart.matches`, `rag.quota_warning`). UIs that don't
 *   know the key MUST ignore the event silently.
 */

/**
 * Incremental text token from the assistant. Multiple events form
 * the final message body via simple string concatenation.
 */
export interface TextDeltaEvent {
    readonly type: 'text-delta'
    readonly delta: string
}

/**
 * The model has decided to invoke a tool. Carries the input the model
 * supplied. Exactly one `tool-result` with the same `callId` MUST
 * follow before the turn ends.
 */
export interface ToolCallEvent {
    readonly type: 'tool-call'
    readonly callId: string
    readonly name: string
    readonly input: unknown
}

/**
 * Optional intermediate update from a long-running tool. Zero or more
 * may appear between a `tool-call` and its matching `tool-result`.
 * `message` is a human-readable status; `data` is arbitrary structured
 * payload (e.g. a partial result, progress counter, etc.).
 */
export interface ToolProgressEvent {
    readonly type: 'tool-progress'
    readonly callId: string
    readonly message?: string
    readonly data?: unknown
}

/**
 * Terminal event for a tool invocation. MUST be emitted exactly once
 * per `tool-call`, with the same `callId`. Either `result` (success)
 * or `error` (failure) is present; never both, never neither.
 */
export interface ToolResultEvent {
    readonly type: 'tool-result'
    readonly callId: string
    readonly result?: unknown
    readonly error?: {
        readonly code: string
        readonly message: string
    }
}

/**
 * A source/reference the assistant relied on. `callId` is OPTIONAL
 * and attaches the citation to a specific tool invocation when set.
 */
export interface CitationEvent {
    readonly type: 'citation'
    readonly source: {
        readonly id?: string
        readonly url?: string
        readonly title?: string
        readonly snippet?: string
    }
    readonly callId?: string
}

/**
 * Backend-specific extension channel. `key` SHOULD be namespaced
 * (`<app>.<event>`, e.g. `rag.quota_warning`, `chart.matches`).
 * `callId` is OPTIONAL; set when the data is tool-scoped.
 *
 * UIs that do not recognise the key MUST ignore the event silently.
 */
export interface DataEvent {
    readonly type: 'data'
    readonly key: string
    readonly value: unknown
    readonly callId?: string
}

/**
 * Stream-level error. Distinct from `tool-result.error` (which is
 * scoped to a single tool invocation). After an `error` event, the
 * server SHOULD close the stream; clients SHOULD treat it as
 * terminal and not wait for `done`.
 */
export interface ErrorEvent {
    readonly type: 'error'
    readonly message: string
    readonly code?: string
}

/**
 * Final event for a successful turn. `text` is OPTIONAL and
 * informational only — see D4. `metadata` carries backend-specific
 * end-of-turn info (token usage, model id, finish reason, etc.).
 */
export interface DoneEvent {
    readonly type: 'done'
    readonly text?: string
    readonly metadata?: unknown
}

/**
 * The full event vocabulary. Discriminate on `type`. Use
 * `assertNever` (exported below) in switch statements so that adding
 * a new event type in a minor version is a compile-time error in
 * every consumer.
 */
export type MaestroEvent =
    | TextDeltaEvent
    | ToolCallEvent
    | ToolProgressEvent
    | ToolResultEvent
    | CitationEvent
    | DataEvent
    | ErrorEvent
    | DoneEvent

/**
 * Discriminator constant. Useful for runtime registries that key off
 * the event type without re-typing the literal union.
 */
export const MAESTRO_EVENT_TYPES = [
    'text-delta',
    'tool-call',
    'tool-progress',
    'tool-result',
    'citation',
    'data',
    'error',
    'done',
] as const satisfies readonly MaestroEvent['type'][]

export type MaestroEventType = (typeof MAESTRO_EVENT_TYPES)[number]

/**
 * User-attached media for a single user message. Surfaced to the
 * `MaestroMessage` aggregate via `attachments?` and forwarded over the
 * wire as a top-level `attachments` field on the POST body.
 *
 * Lifecycle: attachments are uploaded out-of-band BEFORE `send()` is
 * called — the caller's upload code returns a durable URL, then passes
 * that URL into `send(text, { attachments: [...] })`. The protocol
 * itself does not specify the upload mechanism.
 *
 * Backends receive attachments alongside `messages` in the request body
 * (default transport bodies; custom `bodyBuilder`s receive them as a
 * parameter / on `args.attachments`). Backends SHOULD validate the URL
 * against an allowed-origins list before fetching.
 *
 * Added in protocol 0.2.0-beta. Closes GAP-1 surfaced by trading-rag P4
 * adoption: prior to this field, consumers with media uploads kept a
 * side-channel `Map<userMessageId, previewUrl>` because there was no
 * protocol slot for non-text user inputs.
 */
export interface MaestroAttachment {
    /**
     * Categoric kind. Open string — common values are `'image'`,
     * `'file'`, `'video'`, `'audio'`. Renderers SHOULD treat unknown
     * kinds as `'file'`.
     */
    readonly kind: string
    /**
     * Where the content lives. Required. Backends typically receive
     * this AFTER an upload step; the URL is the durable handle.
     */
    readonly url: string
    /** MIME type hint. Optional — backend MAY infer from URL / bytes. */
    readonly mime?: string
    /** Display name for the renderer (e.g. original filename). */
    readonly name?: string
    /** Byte count. Optional — useful for previews and quota checks. */
    readonly size?: number
}

/**
 * Protocol version. Bumped per the policy in `MAESTRO_CHAT_PROTOCOL.md`:
 *   - additive event-type additions  → minor bump
 *   - additive optional fields on existing
 *     events / messages              → minor bump
 *   - removals / renames / breaking
 *     schema changes within an event → major bump
 */
export const MAESTRO_PROTOCOL_VERSION = '0.2.0-beta' as const

/**
 * Exhaustiveness helper. Use in the `default:` branch of a switch
 * over `MaestroEvent['type']` so that adding a new event type is a
 * compile-time error in every consumer:
 *
 *   switch (event.type) {
 *     case 'text-delta': ...
 *     // ... all other cases ...
 *     default:
 *       assertNever(event)
 *   }
 */
export function assertNever(value: never): never {
    throw new Error(
        `MaestroChatProtocol: unhandled event type ${JSON.stringify(value)}`,
    )
}
