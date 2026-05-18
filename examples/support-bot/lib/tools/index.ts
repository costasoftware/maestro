import { escalateTool } from './escalate'
import { lookupTicketTool } from './lookup-ticket'
import { searchKbTool } from './search-kb'
import { summariseTool } from './summarise'
import { updateStatusTool } from './update-status'

/**
 * Tool registry. Order does not matter — kernel adapters iterate the
 * array and apply per-tool filters (`transports`, `actorScope`,
 * `isAvailable`). Hosts that want surface-specific subsets can pre-
 * filter this list before handing it to `runChatTurn` / `registerMcpTools`.
 *
 * Add a new tool: write the file in `lib/tools/`, export from this
 * registry, restart the dev server. No other plumbing.
 *
 * Note: the array is left without an explicit `AnyAgentToolDefinition<...>[]`
 * annotation on purpose — TS infers the union of concrete definitions, which
 * is what both `runChatTurn` and `registerMcpTools` accept (`readonly
 * AgentToolDefinition<any, any, TCtx>[]`). Annotating with
 * `AnyAgentToolDefinition` (whose `TInput = ZodTypeAny`) trips invariance
 * because each tool's concrete `ZodObject<{...}>` is a sub-type but not
 * assignable to the wildcard slot. Inference does the right thing.
 */
export const supportBotTools = [
    lookupTicketTool,
    updateStatusTool,
    searchKbTool,
    escalateTool,
    summariseTool,
]

export {
    escalateTool,
    lookupTicketTool,
    searchKbTool,
    summariseTool,
    updateStatusTool,
}
