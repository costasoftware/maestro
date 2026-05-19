// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ChatInput } from './chat-input.js'

describe('<ChatInput>', () => {
    it('emits onSend with trimmed text when the submit button is clicked', () => {
        const onSend = vi.fn()
        render(<ChatInput onSend={onSend} placeholder="Ask me" />)
        const field = screen.getByPlaceholderText('Ask me') as HTMLInputElement
        fireEvent.change(field, { target: { value: '  hello world  ' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
        expect(onSend).toHaveBeenCalledWith('hello world')
        expect(field.value).toBe('')
    })

    it('ignores empty / whitespace submissions', () => {
        const onSend = vi.fn()
        render(<ChatInput onSend={onSend} />)
        const button = screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement
        expect(button.disabled).toBe(true)
        fireEvent.click(button)
        expect(onSend).not.toHaveBeenCalled()
    })

    it('disables input and submit when disabled=true', () => {
        const onSend = vi.fn()
        render(<ChatInput onSend={onSend} placeholder="Ask" disabled />)
        const field = screen.getByPlaceholderText('Ask') as HTMLInputElement
        expect(field.disabled).toBe(true)
        fireEvent.change(field, { target: { value: 'hi' } })
        const button = screen.getByRole('button', { name: 'Send message' }) as HTMLButtonElement
        expect(button.disabled).toBe(true)
    })

    it('renders <textarea> in multiline mode and submits on Enter (no shift)', () => {
        const onSend = vi.fn()
        render(<ChatInput onSend={onSend} multiline placeholder="Multi" />)
        const textarea = screen.getByPlaceholderText('Multi') as HTMLTextAreaElement
        expect(textarea.tagName).toBe('TEXTAREA')
        fireEvent.change(textarea, { target: { value: 'multi\nline' } })
        fireEvent.keyDown(textarea, { key: 'Enter' })
        expect(onSend).toHaveBeenCalledWith('multi\nline')
    })

    it('does NOT submit on Shift+Enter in multiline mode', () => {
        const onSend = vi.fn()
        render(<ChatInput onSend={onSend} multiline placeholder="Multi" />)
        const textarea = screen.getByPlaceholderText('Multi') as HTMLTextAreaElement
        fireEvent.change(textarea, { target: { value: 'first line' } })
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
        expect(onSend).not.toHaveBeenCalled()
    })
})
