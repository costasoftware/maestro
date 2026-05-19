// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { UseMaestroChatReturn } from '../hook.js'
import type { MaestroMessage } from '../message.js'
import { ChatPanel } from './chat-panel.js'

type DataMap = Record<string, unknown>

function makeChat(
    overrides: Partial<UseMaestroChatReturn<DataMap>> = {},
): UseMaestroChatReturn<DataMap> {
    return {
        messages: [],
        isLoading: false,
        error: null,
        send: vi.fn(),
        abort: vi.fn(),
        reset: vi.fn(),
        append: vi.fn(),
        ...overrides,
    }
}

function user(id: string, text: string): MaestroMessage<DataMap> {
    return {
        id,
        role: 'user',
        text,
        toolCalls: [],
        citations: [],
        data: [],
        status: 'complete',
        createdAt: Number(id),
    }
}

function assistant(id: string, text: string): MaestroMessage<DataMap> {
    return {
        id,
        role: 'assistant',
        text,
        toolCalls: [],
        citations: [],
        data: [],
        status: 'complete',
        createdAt: Number(id),
    }
}

describe('<ChatPanel>', () => {
    it('renders the empty state when there are no messages', () => {
        const chat = makeChat()
        render(<ChatPanel chat={chat} emptyState={<p>start chatting</p>} />)
        expect(screen.getByText('start chatting')).toBeTruthy()
    })

    it('renders user and assistant bubbles from chat.messages', () => {
        const chat = makeChat({
            messages: [user('1', 'hi'), assistant('2', 'hello')],
        })
        render(<ChatPanel chat={chat} />)
        const bubbles = document.querySelectorAll('.maestro-chat-bubble')
        expect(bubbles).toHaveLength(2)
        expect(document.querySelector('.maestro-chat-bubble--user')).not.toBeNull()
        expect(document.querySelector('.maestro-chat-bubble--assistant')).not.toBeNull()
    })

    it('calls chat.send on submit', () => {
        const send = vi.fn()
        const chat = makeChat({ send })
        render(<ChatPanel chat={chat} placeholder="Ask anything" />)
        const field = screen.getByPlaceholderText('Ask anything') as HTMLInputElement
        fireEvent.change(field, { target: { value: 'how are you' } })
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
        })
        expect(send).toHaveBeenCalledWith('how are you')
    })

    it('disables input + shows Stop button while loading', () => {
        const abort = vi.fn()
        const chat = makeChat({ isLoading: true, abort })
        render(<ChatPanel chat={chat} placeholder="Ask" />)
        const field = screen.getByPlaceholderText('Ask') as HTMLInputElement
        expect(field.disabled).toBe(true)
        const stop = screen.getByRole('button', { name: 'Stop' })
        fireEvent.click(stop)
        expect(abort).toHaveBeenCalled()
    })

    it('surfaces chat.error in a dedicated alert region', () => {
        const chat = makeChat({
            error: { code: 'QUOTA_EXCEEDED', message: 'quota reached' },
        })
        render(<ChatPanel chat={chat} />)
        const alert = screen.getByRole('alert')
        expect(alert.textContent).toContain('QUOTA_EXCEEDED')
        expect(alert.textContent).toContain('quota reached')
    })
})
