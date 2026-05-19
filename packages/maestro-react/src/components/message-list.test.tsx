// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { MaestroMessage } from '../message.js'
import { MessageList } from './message-list.js'

type DataMap = Record<string, unknown>

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

function assistant(
    id: string,
    text: string,
    status: MaestroMessage<DataMap>['status'] = 'complete',
): MaestroMessage<DataMap> {
    return {
        id,
        role: 'assistant',
        text,
        toolCalls: [],
        citations: [],
        data: [],
        status,
        createdAt: Number(id),
    }
}

describe('<MessageList>', () => {
    it('renders one bubble per message with the correct role class', () => {
        const messages = [
            user('1', 'hi'),
            assistant('2', 'hello back'),
            user('3', 'how are you?'),
        ]
        render(<MessageList messages={messages} />)
        const bubbles = document.querySelectorAll('.maestro-chat-bubble')
        expect(bubbles).toHaveLength(3)
        expect(screen.getByText('hi')).toBeTruthy()
        expect(screen.getByText('hello back')).toBeTruthy()
    })

    it('respects renderMessage override', () => {
        const messages = [user('1', 'override me'), assistant('2', 'me too')]
        render(
            <MessageList
                messages={messages}
                renderMessage={m => (
                    <span data-testid={`custom-${m.id}`}>
                        {m.role}:{m.text}
                    </span>
                )}
            />,
        )
        // Custom render for both messages, by unique testid.
        expect(screen.getByTestId('custom-1').textContent).toBe('user:override me')
        expect(screen.getByTestId('custom-2').textContent).toBe('assistant:me too')
        // Default bubble class should NOT appear when overridden.
        expect(document.querySelector('.maestro-chat-bubble')).toBeNull()
    })

    it('triggers scrollIntoView when autoscroll is enabled', () => {
        const messages = [assistant('1', 'one')]
        const { rerender } = render(<MessageList messages={messages} autoScroll />)
        const scrollSpy = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>
        expect(scrollSpy).toHaveBeenCalled()
        scrollSpy.mockClear()
        rerender(<MessageList messages={[...messages, assistant('2', 'two')]} autoScroll />)
        expect(scrollSpy).toHaveBeenCalled()
    })

    it('skips autoscroll when autoScroll=false', () => {
        const messages = [assistant('1', 'one')]
        const { rerender } = render(<MessageList messages={messages} autoScroll={false} />)
        const scrollSpy = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>
        scrollSpy.mockClear()
        rerender(
            <MessageList messages={[...messages, assistant('2', 'two')]} autoScroll={false} />,
        )
        expect(scrollSpy).not.toHaveBeenCalled()
    })
})
