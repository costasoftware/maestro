// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MaestroMessage } from '../message.js'
import type { DataRendererRegistry } from './data-renderers.js'
import { MessageBubble } from './message-bubble.js'

beforeEach(() => {
    class FakeIO {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
        takeRecords(): unknown[] { return [] }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        constructor(_cb: unknown) {}
    }
    Object.defineProperty(globalThis, 'IntersectionObserver', {
        value: FakeIO,
        configurable: true,
        writable: true,
    })
    Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView']
})

interface SupportDataMap {
    'ticket.summary': { id: string; title: string; status: string }
    'quota.warning': { remaining: number }
}

function bubbleFor(
    data: ReadonlyArray<MaestroMessage<SupportDataMap>['data'][number]>,
): MaestroMessage<SupportDataMap> {
    return {
        id: 'm1',
        role: 'assistant',
        text: 'ok',
        toolCalls: [],
        citations: [],
        data,
        status: 'complete',
        createdAt: 1,
    }
}

describe('DataRendererRegistry — typed dispatch', () => {
    it('invokes the matching renderer with the narrowly-typed value', () => {
        const TicketSummary = vi.fn((props: { value: { id: string; title: string; status: string } }) => (
            <div data-testid="ticket">
                {props.value.id} — {props.value.title} ({props.value.status})
            </div>
        ))
        const QuotaWarning = vi.fn((props: { value: { remaining: number } }) => (
            <div data-testid="quota">remaining {props.value.remaining}</div>
        ))

        const registry: DataRendererRegistry<SupportDataMap> = {
            'ticket.summary': TicketSummary,
            'quota.warning': QuotaWarning,
        }

        const message = bubbleFor([
            {
                key: 'ticket.summary',
                value: { id: 'TKT-001', title: 'Login fails', status: 'open' },
            },
            { key: 'quota.warning', value: { remaining: 3 } },
        ])

        render(<MessageBubble message={message} dataRenderers={registry} />)

        // Both renderers fired with the right typed value.
        expect(TicketSummary).toHaveBeenCalledTimes(1)
        expect(TicketSummary.mock.calls[0]?.[0]).toMatchObject({
            value: { id: 'TKT-001', title: 'Login fails', status: 'open' },
        })
        expect(QuotaWarning).toHaveBeenCalledTimes(1)
        expect(screen.getByTestId('ticket').textContent).toContain('TKT-001')
        expect(screen.getByTestId('quota').textContent).toContain('remaining 3')
    })

    it('falls back to a generic JSON renderer when the key is unknown', () => {
        const registry: DataRendererRegistry<SupportDataMap> = {
            'ticket.summary': () => <span>known</span>,
            // quota.warning intentionally omitted
        }

        const message = bubbleFor([{ key: 'quota.warning', value: { remaining: 1 } }])

        render(<MessageBubble message={message} dataRenderers={registry} />)

        // The fallback `<pre>` carries `data-key` for debugging.
        const fallback = document.querySelector('[data-key="quota.warning"]')
        expect(fallback).not.toBeNull()
        expect(fallback?.textContent).toContain('remaining')
    })

    it('passes callId to the renderer when one is present', () => {
        const Spy = vi.fn((_props: { value: SupportDataMap['ticket.summary']; callId?: string }) => (
            <span>ok</span>
        ))
        const registry: DataRendererRegistry<SupportDataMap> = {
            'ticket.summary': Spy,
        }
        const message = bubbleFor([
            {
                key: 'ticket.summary',
                value: { id: 'TKT-9', title: 'x', status: 'open' },
                callId: 'call-42',
            },
        ])
        render(<MessageBubble message={message} dataRenderers={registry} />)
        expect(Spy.mock.calls[0]?.[0]).toMatchObject({ callId: 'call-42' })
    })
})
