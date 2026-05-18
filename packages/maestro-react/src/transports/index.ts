// Transport implementations + the contract they conform to. Each
// transport accepts a generic `TDataMap` parameter for typed `data`
// events; consumers who don't care pass `Record<string, unknown>`.
export {
    aiSdkTransport,
    type AiSdkTransportOptions,
} from './ai-sdk.js'
export {
    httpSSETransport,
    type HttpSSETransportOptions,
} from './http-sse.js'
export {
    type LegacyEventMap,
    type LegacyEventMapContext,
    type LegacyEventMapper,
    legacySseTransport,
    type LegacySseTransportOptions,
} from './legacy-sse.js'
