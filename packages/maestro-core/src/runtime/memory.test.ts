import { describe, expect, it, vi } from 'vitest'

import type { MemoryRecord, MemoryStore } from '../ports/memory-store.js'
import { formatMemoryBlock, loadMemoryBlock } from './memory.js'

const SCOPE = { tenantId: '1', principalId: 'u1' }
const FIXED = new Date('2026-05-17T10:00:00.000Z')

function record(fact: string): MemoryRecord {
    return {
        id: `mem_${Math.random().toString(36).slice(2, 8)}`,
        scope: SCOPE,
        fact,
        source: 'test',
        createdAt: FIXED,
        updatedAt: FIXED,
    }
}

describe('formatMemoryBlock', () => {
    it('returns empty string for empty records', () => {
        expect(formatMemoryBlock([])).toBe('')
    })

    it('formats a single record with default header', () => {
        const block = formatMemoryBlock([record('they prefer Sundays off')])
        expect(block).toContain('User context')
        expect(block).toContain('- they prefer Sundays off')
    })

    it('formats multiple records as bullet list', () => {
        const block = formatMemoryBlock([
            record('cat named Toby'),
            record('allergic to anise'),
        ])
        expect(block.split('\n')).toHaveLength(3) // header + 2 facts
    })

    it('honours custom header', () => {
        const block = formatMemoryBlock([record('x')], 'About this customer:')
        expect(block.startsWith('About this customer:')).toBe(true)
    })
})

describe('loadMemoryBlock', () => {
    it('calls the port with the supplied scope and returns the formatted block', async () => {
        const memoryStore: MemoryStore = {
            load: vi.fn().mockResolvedValue([record('hello world')]),
            save: vi.fn(),
            forget: vi.fn(),
        }

        const block = await loadMemoryBlock({
            memoryStore,
            scope: SCOPE,
        })

        expect(memoryStore.load).toHaveBeenCalledWith(SCOPE)
        expect(block).toContain('- hello world')
    })

    it('returns empty string when the port returns no records', async () => {
        const memoryStore: MemoryStore = {
            load: vi.fn().mockResolvedValue([]),
            save: vi.fn(),
            forget: vi.fn(),
        }
        expect(await loadMemoryBlock({ memoryStore, scope: SCOPE })).toBe('')
    })
})
