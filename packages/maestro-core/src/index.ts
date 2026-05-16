// Tool definition + envelope
export type { BaseToolContext } from './context.js'
export { err, isOk, ok, type ToolEnvelope, type ToolMeta } from './envelope.js'
export {
    type AgentToolDefinition,
    type AnyAgentToolDefinition,
    defineAgentTool,
    type ToolCostBand,
    type ToolKind,
} from './tool.js'

// Cross-cutting kernel utilities
export {
    applyCacheBreakpoints,
    type CacheableBlock,
    type CachedMessages,
} from './cache-control.js'
export {
    captureToolException,
    type ToolExceptionHandler,
    type ToolExceptionTags,
} from './safe-tool.js'

// Ports re-exported at root for ergonomic single-import setups
export * from './ports/index.js'
