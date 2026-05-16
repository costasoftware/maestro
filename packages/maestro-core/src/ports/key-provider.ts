/**
 * Returns the model-provider API key the kernel should use for a given
 * call. The host wires this from `process.env`, a secrets manager, or
 * a per-tenant BYO-key table.
 *
 * Why a port: secret-fetch is host-defined (env layout, rotation
 * cadence, multi-key load balancing). Kernel must not assume any of it.
 */
export type ModelProvider = 'anthropic' | 'openai'

export interface ModelKeyProvider {
    /**
     * Resolve the key for the given provider. `tenantId` is passed so
     * BYO-key hosts can return per-tenant keys; hosts with a single
     * platform key can ignore it.
     */
    getKey(provider: ModelProvider, tenantId?: string): Promise<string>
}
