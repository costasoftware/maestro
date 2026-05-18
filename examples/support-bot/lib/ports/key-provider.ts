import type { ModelKeyProvider, ModelProvider } from '@costasoftware/maestro-core'

/**
 * Pulls Anthropic / OpenAI keys from `process.env`. Real products with
 * BYO-key support consult a per-tenant key table here using the
 * `tenantId` arg; this example uses a single platform key so the arg
 * is unused.
 */
export class EnvKeyProvider implements ModelKeyProvider {
    async getKey(provider: ModelProvider): Promise<string> {
        const envVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
        const key = process.env[envVar]
        if (!key) {
            throw new Error(
                `${envVar} is not configured. Copy .env.example to .env and add a key.`
            )
        }
        return key
    }
}
