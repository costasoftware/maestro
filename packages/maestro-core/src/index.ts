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
    BLENDED_PRICING,
    estimateCost,
    MODEL_PRICING,
    type PricingRow,
    type TokenUsage,
} from './cost.js'
export {
    DEFAULT_SMART_KEYWORDS,
    DEFAULT_SMART_LENGTH_THRESHOLD,
    DEFAULT_SMART_TURN_THRESHOLD,
    type ModelSelection,
    type ModelTier,
    selectChatModel,
    type SelectModelArgs,
} from './models.js'
export {
    captureToolException,
    type ToolExceptionHandler,
    type ToolExceptionTags,
} from './safe-tool.js'

// Ports re-exported at root for ergonomic single-import setups
export * from './ports/index.js'

// Window-math helpers — host `QuotaStore` impls import these to
// compute consistent counter keys / TTLs / reset times. Not used
// directly by `runChatTurn`; exposed for the host port boundary.
export {
    DAY_SECONDS,
    DAY_TTL_SECONDS,
    dailyCostWindow,
    dailyTokensWindow,
    dayKeyUtc,
    HOUR_SECONDS,
    HOUR_TTL_SECONDS,
    hourKeyUtc,
    hourlyToolCallsWindow,
    nextUtcHour,
    nextUtcMidnight,
    type WindowDescriptor,
} from './windows.js'
