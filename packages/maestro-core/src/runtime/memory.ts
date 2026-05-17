import type { MemoryRecord, MemoryScope, MemoryStore } from '../ports/memory-store.js'

/**
 * Load + format memory facts for system-prompt injection.
 *
 * Pull semantics: the kernel asks the host's MemoryStore for ALL facts
 * matching the scope, then formats them as a compact prose block. The
 * host is responsible for any retrieval / semantic filtering — barbeiro's
 * impl, for example, runs a relevance pass via embeddings before
 * returning. The kernel does not do retrieval; it just consumes the
 * already-selected list.
 *
 * Output goes in the DYNAMIC system segment (varies per principal,
 * cannot be cached). Anthropic prompt cache would split per-user
 * otherwise, killing cross-tenant cache reuse.
 *
 * Returns `''` (empty string) when there are no facts so callers can
 * safely concatenate to existing dynamic content without conditional
 * branching.
 */
export interface LoadMemoryBlockArgs {
    memoryStore: MemoryStore
    scope: MemoryScope
    /** Optional header line. Defaults to a generic prefix. */
    header?: string
}

export async function loadMemoryBlock(args: LoadMemoryBlockArgs): Promise<string> {
    const records = await args.memoryStore.load(args.scope)
    return formatMemoryBlock(records, args.header)
}

/**
 * Pure formatter — separated from the port call so tests can drive
 * arbitrary record sets without standing up a fake store.
 */
export function formatMemoryBlock(
    records: readonly MemoryRecord[],
    header = 'User context (memories you should keep in mind):'
): string {
    if (records.length === 0) return ''
    const lines = records.map((r) => `- ${r.fact}`)
    return `${header}\n${lines.join('\n')}`
}
