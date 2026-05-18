// MaestroChatProtocol — wire-format-neutral event vocabulary for chat
// surfaces. See `./protocol.ts` for the design decisions and the
// repo-root `MAESTRO_CHAT_PROTOCOL.md` for the language-neutral spec.
export {
    assertNever,
    type CitationEvent,
    type DataEvent,
    type DoneEvent,
    type ErrorEvent,
    MAESTRO_EVENT_TYPES,
    MAESTRO_PROTOCOL_VERSION,
    type MaestroEvent,
    type MaestroEventType,
    type TextDeltaEvent,
    type ToolCallEvent,
    type ToolProgressEvent,
    type ToolResultEvent,
} from './protocol.js'
