import { ConsoleAuditStore } from './audit-store'
import { EnvKeyProvider } from './key-provider'
import { InMemoryMemoryStore } from './memory-store'
import { InMemoryQuotaStore } from './quota-store'
import { ConsoleTelemetrySink } from './telemetry-sink'
import { InMemoryTurnStore } from './turn-store'

/**
 * Process-singleton bundle of port instances. Real products would build
 * these from their container / DI scope; here we just construct one of
 * each at module load and re-use them across requests.
 *
 * The kernel takes ports as an explicit argument bag on every
 * `runChatTurn` call — there is no global state inside the kernel. This
 * lets a single Next.js process serve multiple "products" off the same
 * kernel install if it ever needs to (different ports per route, same
 * `maestro-core` binary).
 */
export const supportBotPorts = {
    turnStore: new InMemoryTurnStore(),
    memoryStore: new InMemoryMemoryStore(),
    quotaStore: new InMemoryQuotaStore(),
    auditStore: new ConsoleAuditStore(),
    keyProvider: new EnvKeyProvider(),
    telemetry: new ConsoleTelemetrySink(),
} as const

export {
    ConsoleAuditStore,
    ConsoleTelemetrySink,
    EnvKeyProvider,
    InMemoryMemoryStore,
    InMemoryQuotaStore,
    InMemoryTurnStore,
}
