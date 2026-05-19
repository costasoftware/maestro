// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { MaestroToolCall } from '../message.js'
import { ToolCallCard } from './tool-call-card.js'

const baseCall: MaestroToolCall = {
    callId: 'c1',
    name: 'lookupTicket',
    input: { id: 'TKT-001' },
    status: 'success',
    progress: [],
    result: { title: 'Login fails' },
}

describe('<ToolCallCard>', () => {
    it('renders collapsed by default — input JSON not in the DOM', () => {
        render(<ToolCallCard call={baseCall} />)
        expect(screen.getByText('lookupTicket')).toBeTruthy()
        expect(screen.getByText('success')).toBeTruthy()
        // Collapsed body — input JSON should NOT be present yet.
        expect(screen.queryByText(/TKT-001/)).toBeNull()
        const header = screen.getByRole('button')
        expect(header.getAttribute('aria-expanded')).toBe('false')
    })

    it('expands when the header is clicked, showing input/result JSON', () => {
        render(<ToolCallCard call={baseCall} />)
        const header = screen.getByRole('button')
        fireEvent.click(header)
        expect(header.getAttribute('aria-expanded')).toBe('true')
        expect(screen.getByText(/TKT-001/)).toBeTruthy()
        expect(screen.getByText(/Login fails/)).toBeTruthy()
    })

    it('honours defaultExpanded=true', () => {
        render(<ToolCallCard call={baseCall} defaultExpanded />)
        const header = screen.getByRole('button')
        expect(header.getAttribute('aria-expanded')).toBe('true')
        expect(screen.getByText(/TKT-001/)).toBeTruthy()
    })

    it('renders an inline error message for errored tool calls', () => {
        const errored: MaestroToolCall = {
            ...baseCall,
            status: 'errored',
            result: undefined,
            error: { code: 'NOT_FOUND', message: 'ticket missing' },
        }
        render(<ToolCallCard call={errored} />)
        expect(screen.getByText('NOT_FOUND')).toBeTruthy()
        expect(screen.getByText(/ticket missing/)).toBeTruthy()
        expect(screen.getByText('errored')).toBeTruthy()
    })

    it('skips the result section when the call is still pending/running', () => {
        const running: MaestroToolCall = {
            ...baseCall,
            status: 'running',
            result: undefined,
            progress: [{ message: 'fetching' }],
        }
        render(<ToolCallCard call={running} defaultExpanded />)
        // Progress section visible.
        expect(screen.getByText(/fetching/)).toBeTruthy()
        // Result section title should NOT render — there's no result yet.
        const titles = Array.from(
            document.querySelectorAll('.maestro-tool-call-card__section-title'),
        ).map(el => el.textContent)
        expect(titles).not.toContain('result')
        expect(titles).toContain('input')
        expect(titles).toContain('progress')
    })
})
