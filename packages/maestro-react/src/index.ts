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
    type MaestroAttachment,
    type MaestroEvent,
    type MaestroEventType,
    type TextDeltaEvent,
    type ToolCallEvent,
    type ToolProgressEvent,
    type ToolResultEvent,
} from './protocol.js'

// Aggregated message shapes — what the reducer + hook produce.
export {
    citationFromEvent,
    errorFromEvent,
    type MaestroCitation,
    type MaestroData,
    type MaestroError,
    type MaestroMessage,
    type MaestroToolCall,
    progressFromEvent,
} from './message.js'

// Pure reducer — exported for advanced consumers (server-side replay,
// snapshot recovery, custom hooks). The default hook uses it internally.
export {
    abortMessage,
    applyEvent,
    createAssistantMessage,
    createUserMessage,
    failMessage,
} from './reducer.js'

// Transport contract + bundled implementations.
export type {
    BodyBuilderArgs,
    Transport,
    TransportSendArgs,
} from './transport.js'
export {
    aiSdkTransport,
    type AiSdkTransportOptions,
    httpSSETransport,
    type HttpSSETransportOptions,
    type LegacyEventMap,
    type LegacyEventMapContext,
    type LegacyEventMapper,
    legacySseTransport,
    type LegacySseTransportOptions,
} from './transports/index.js'

// The headless hook — driven by a Transport, returns reactive messages.
export {
    useMaestroChat,
    type UseMaestroChatOptions,
    type UseMaestroChatReturn,
} from './hook.js'

// React UI primitives (P3). Both the composed shell trio
// (`ChatLauncher` + `ChatSheet` + `ChatPanel`) and the underlying
// building blocks (`MessageList`, `MessageBubble`, `ChatInput`,
// `ToolCallCard`, `CitationCard`) ship from a single import surface.
// Pure CSS + CSS-vars theming; no Radix / Tailwind / animation runtime.
export {
    ChatInput,
    type ChatInputProps,
    ChatLauncher,
    type ChatLauncherProps,
    ChatPanel,
    type ChatPanelProps,
    ChatSheet,
    type ChatSheetProps,
    CitationCard,
    type CitationCardProps,
    type DataRendererProps,
    type DataRendererRegistry,
    MessageBubble,
    type MessageBubbleProps,
    MessageList,
    type MessageListProps,
    ToolCallCard,
    type ToolCallCardProps,
    useAutoScroll,
    type UseAutoScrollResult,
} from './components/index.js'
