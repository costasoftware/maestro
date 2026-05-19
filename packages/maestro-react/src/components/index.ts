// === Shell components — the "composed" surface ===
export { ChatLauncher, type ChatLauncherProps } from './chat-launcher.js'
export { ChatSheet, type ChatSheetProps } from './chat-sheet.js'
export { ChatPanel, type ChatPanelProps } from './chat-panel.js'

// === Building blocks — usable inside ChatPanel or standalone ===
export { MessageList, type MessageListProps } from './message-list.js'
export { MessageBubble, type MessageBubbleProps } from './message-bubble.js'
export { ChatInput, type ChatInputProps } from './chat-input.js'
export { ToolCallCard, type ToolCallCardProps } from './tool-call-card.js'
export { CitationCard, type CitationCardProps } from './citation-card.js'

// === Renderer registry type ===
export {
    type DataRendererProps,
    type DataRendererRegistry,
} from './data-renderers.js'

// === Internal hook (exported for advanced layouts) ===
export { useAutoScroll, type UseAutoScrollResult } from './scroll-anchor.js'
