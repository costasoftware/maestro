# MaestroChatProtocol

**Version:** `0.1.0-beta`
**Status:** unlocked. The shape is locked only after a non-TypeScript backend (trading-rag, FastAPI) implements it natively as part of P4. Until then, additions are permitted; renames/removals are not.

A wire-format-neutral event vocabulary for streaming chat surfaces backed by LLMs. The protocol exists so that a single React chat client can render conversations produced by any compatible backend — whether that backend uses the Vercel AI SDK v6 wire format, custom Node SSE, or custom FastAPI SSE — without per-consumer event mapping in the UI layer.

The TypeScript reference implementation lives at [`packages/maestro-react/src/protocol.ts`](./packages/maestro-react/src/protocol.ts). The types in that file ARE the spec for TS consumers; this document is the spec for everyone else.

---

## Wire format

- Transport: HTTP `POST` returning `text/event-stream` (SSE).
- One event per SSE `data:` line.
- Payload is a single JSON object, UTF-8 encoded, no trailing whitespace.
- The top-level `type` field is the discriminator and MUST appear first when serialised (for human debuggability — not load-bearing for parsers).
- Servers SHOULD NOT use SSE `event:` names; the `type` field inside the payload is authoritative.
- Servers MAY emit SSE comments (`:keepalive\n\n`) at any time; clients MUST ignore them.

Example single line:

```
data: {"type":"text-delta","delta":"hello"}
```

---

## Event reference

The eight event types below form the entire vocabulary. Backends MUST NOT invent new top-level event types; extensions go through the `data` event.

### `text-delta`

Incremental assistant text. The final message body is the concatenation of every `text-delta` event's `delta` field, in order.

```json
{ "type": "text-delta", "delta": "Hello, " }
{ "type": "text-delta", "delta": "world." }
```

### `tool-call`

The model has decided to invoke a tool.

```json
{
    "type": "tool-call",
    "callId": "call_8f2c",
    "name": "searchBookings",
    "input": { "q": "tomorrow afternoon" }
}
```

- `callId` MUST be unique within a single response stream.
- `input` SHOULD be the exact arguments the model produced, JSON-serialisable.

### `tool-progress`

Optional intermediate update from a long-running tool. Zero or more may appear between a `tool-call` and its matching `tool-result`.

```json
{
    "type": "tool-progress",
    "callId": "call_8f2c",
    "message": "Fetching page 2 of 7",
    "data": { "page": 2, "total": 7 }
}
```

- `message` is a human-readable status, suitable for a UI status chip.
- `data` is arbitrary backend-defined payload. UIs that don't know it MUST ignore it.

### `tool-result`

Terminal event for a tool invocation. MUST be emitted exactly once per `tool-call`, with the same `callId`. Either `result` (success) or `error` (failure), never both, never neither.

```json
{ "type": "tool-result", "callId": "call_8f2c", "result": { "count": 3 } }
```

```json
{
    "type": "tool-result",
    "callId": "call_8f2c",
    "error": { "code": "TIMEOUT", "message": "Upstream gateway timed out" }
}
```

### `citation`

A source the assistant relied on.

```json
{
    "type": "citation",
    "source": {
        "id": "doc_42",
        "url": "https://example.com/post",
        "title": "Example Post",
        "snippet": "…relevant excerpt…"
    },
    "callId": "call_8f2c"
}
```

- All `source.*` fields are OPTIONAL but at least one of `id`/`url` SHOULD be set so the UI can de-duplicate.
- `callId` is OPTIONAL; set it when the citation is scoped to a specific tool invocation.

### `data`

Backend-specific extension channel.

```json
{
    "type": "data",
    "key": "rag.quota_warning",
    "value": { "remaining": 3 },
    "callId": "call_8f2c"
}
```

- `key` SHOULD be namespaced (`<app>.<event>`, e.g. `rag.quota_warning`, `chart.matches`).
- UIs that do NOT recognise the key MUST ignore the event silently.
- `callId` is OPTIONAL; set when the data is tool-scoped.

### `error`

Stream-level error. Distinct from `tool-result.error` (which is scoped to a single tool invocation). After an `error` event the server SHOULD close the stream; clients SHOULD treat it as terminal and not wait for `done`.

```json
{ "type": "error", "message": "Upstream unavailable", "code": "UPSTREAM_DOWN" }
```

### `done`

Final event for a successful turn.

```json
{
    "type": "done",
    "text": "Hello, world.",
    "metadata": {
        "usage": { "input_tokens": 100, "output_tokens": 50 },
        "model": "claude-opus-4-7",
        "finish_reason": "stop"
    }
}
```

- `text` is OPTIONAL and informational. The final assistant text MUST be reconstructable from the `text-delta` stream alone; `text` exists only as a convenience restate.
- `metadata` is backend-defined.

---

## Sequencing rules

1. A turn ends when the server sends either `done` or `error`. Clients MUST treat the stream as closed after either.
2. For every `tool-call` with id `X`, the server MUST emit exactly one `tool-result` with the same id before `done`. Zero or more `tool-progress` events with id `X` MAY appear between them.
3. Concurrent tool calls are permitted — interleaved progress/result events with different `callId`s are valid.
4. `text-delta` events MAY appear at any point before `done`, including between `tool-call`/`tool-result` pairs.
5. **One `done` per POST in v0.1.** Multi-message-per-POST flows are an open question — see "Open questions" below.

---

## Reserved event types

The eight types above (`text-delta`, `tool-call`, `tool-progress`, `tool-result`, `citation`, `data`, `error`, `done`) are the entire vocabulary. Backends MUST NOT define new top-level types.

For app-specific events, emit a `data` event with a namespaced `key`. Examples:

| Backend feature | Recommended `key` |
| --- | --- |
| Trading-rag chart matches | `chart.matches` |
| Trading-rag agent step trace | Use `tool-progress` (it's first-class) |
| Barbeiro rate-limit warning | `quota.warning` |
| Barbeiro inline data attachment | `data.<name>` |

---

## Versioning policy

Semantic versioning, with `0.1.0-beta` as the first published shape.

| Change | Bump |
| --- | --- |
| Add a new event type | minor |
| Add an OPTIONAL field to an existing event | minor |
| Rename a field | major |
| Remove a field | major |
| Change a field's type | major |
| Tighten validation (formerly accepted payloads now rejected) | major |

The protocol version is exposed in TS as `MAESTRO_PROTOCOL_VERSION` from `@costasoftware/maestro-react`. Backends SHOULD echo the version they target somewhere in their `done.metadata` or a `data` event with `key: "maestro.protocol_version"`.

---

## Validation

JSON Schema artefacts are NOT shipped in `0.1.0-beta`. They will live at `packages/maestro-react/schema/v0/*.json` once the shape is locked at the end of P4. Until then, the TS union in [`packages/maestro-react/src/protocol.ts`](./packages/maestro-react/src/protocol.ts) is the canonical source of truth and the only validator.

---

## Open questions (deferred past v0.1)

- **Multi-message-per-POST.** Trading-rag has flows that semantically produce intro → tool call → summary as three distinct assistant messages from a single POST. v0.1 requires collapsing them into a single turn OR opening multiple POSTs. A future `turn-boundary` event is a candidate; the decision will land during P4 trading-rag adoption.
- **Cancellation.** No client→server cancellation event in v0.1. Clients abort by closing the SSE connection. A typed cancel envelope is a P5+ topic.
- **Resume / replay.** No event-ID / cursor-based resume in v0.1. Streams are one-shot.

---

## Python reference implementation

For Python backends (e.g. FastAPI + `sse-starlette`). Drop-in helper using Pydantic v2.

```python
# maestro_chat_protocol.py
from typing import Annotated, Any, Literal, Optional, Union
from pydantic import BaseModel, Field
from sse_starlette import EventSourceResponse


class TextDelta(BaseModel):
    type: Literal["text-delta"] = "text-delta"
    delta: str


class ToolCall(BaseModel):
    type: Literal["tool-call"] = "tool-call"
    callId: str
    name: str
    input: Any


class ToolProgress(BaseModel):
    type: Literal["tool-progress"] = "tool-progress"
    callId: str
    message: Optional[str] = None
    data: Optional[Any] = None


class ToolError(BaseModel):
    code: str
    message: str


class ToolResult(BaseModel):
    type: Literal["tool-result"] = "tool-result"
    callId: str
    result: Optional[Any] = None
    error: Optional[ToolError] = None


class CitationSource(BaseModel):
    id: Optional[str] = None
    url: Optional[str] = None
    title: Optional[str] = None
    snippet: Optional[str] = None


class Citation(BaseModel):
    type: Literal["citation"] = "citation"
    source: CitationSource
    callId: Optional[str] = None


class Data(BaseModel):
    type: Literal["data"] = "data"
    key: str
    value: Any
    callId: Optional[str] = None


class Error(BaseModel):
    type: Literal["error"] = "error"
    message: str
    code: Optional[str] = None


class Done(BaseModel):
    type: Literal["done"] = "done"
    text: Optional[str] = None
    metadata: Optional[Any] = None


MaestroEvent = Annotated[
    Union[TextDelta, ToolCall, ToolProgress, ToolResult, Citation, Data, Error, Done],
    Field(discriminator="type"),
]


def _send_event(event: BaseModel) -> dict[str, str]:
    """Serialise a MaestroEvent for sse-starlette's EventSourceResponse."""
    # `data` is the only field SSE clients read for this protocol.
    # We deliberately do NOT set `event:` — `type` inside the payload
    # is authoritative.
    return {"data": event.model_dump_json(exclude_none=True)}


# Example usage inside a FastAPI route:
#
# async def stream():
#     yield _send_event(TextDelta(delta="hello "))
#     yield _send_event(
#         ToolCall(callId="c1", name="search", input={"q": "x"})
#     )
#     yield _send_event(
#         ToolResult(callId="c1", result={"hits": 3})
#     )
#     yield _send_event(TextDelta(delta="found 3."))
#     yield _send_event(Done(metadata={"model": "claude-opus-4-7"}))
#
# @app.post("/chat")
# def chat():
#     return EventSourceResponse(stream())
```

This snippet is documentation only in v1. There is no published PyPI package; if trading-rag adoption (P4) proves it useful, a `maestro-protocol-python` package can follow.
