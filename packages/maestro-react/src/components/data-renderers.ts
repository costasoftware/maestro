/**
 * `DataRendererRegistry<TDataMap>` — typed mapping from `data` event
 * keys to React components that render them.
 *
 * Mirrors the shape of `TDataMap` exposed by `useMaestroChat`:
 *
 *   interface MyDataMap {
 *       'rag.quota': { remaining: number; limit: number }
 *       'chart.matches': { count: number }
 *   }
 *
 *   const renderers: DataRendererRegistry<MyDataMap> = {
 *       'rag.quota':    ({ value }) => <QuotaChip {...value} />,
 *       'chart.matches': ({ value }) => <span>{value.count} matches</span>,
 *   }
 *
 * The `value` prop is exactly `TDataMap[K]` — typed per key, so the
 * component receives a narrow payload instead of `unknown`. Missing
 * entries are fine: any `data` whose key is not in the registry falls
 * back to a generic JSON renderer in `<MessageBubble>`.
 */

import type { ComponentType } from 'react'

export interface DataRendererProps<TValue> {
    readonly value: TValue
    /**
     * Optional correlator — present when the host backend attached the
     * `data` event to a specific tool invocation. Renderers that show
     * "result of <tool>" affordances can use this to look up the tool
     * call alongside the data payload.
     */
    readonly callId?: string
}

export type DataRendererRegistry<TDataMap> = {
    readonly [K in keyof TDataMap]?: ComponentType<DataRendererProps<TDataMap[K]>>
}
