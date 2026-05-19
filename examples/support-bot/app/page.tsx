'use client'

import { useRef } from 'react'
import {
    aiSdkTransport,
    ChatPanel,
    type DataRendererRegistry,
    useMaestroChat,
} from 'maestro-react'

/**
 * Support copilot UI — now built on the `maestro-react` UI primitives
 * shipped in P3 instead of a hand-rolled fetch + EventSource reader.
 *
 * `aiSdkTransport` translates the AI SDK v6 `UIMessageStream` chunks
 * the route writes (`text-delta`, `data-status`, `tool-input-available`,
 * `tool-output-available`, `finish`) into `MaestroEvent`s. `<ChatPanel>`
 * then renders messages, tool-call cards, error banners, and the
 * input — all from a single component.
 *
 * The `SupportBotDataMap` registry below gives us a typed renderer
 * for the bot's `data-status` chip ("thinking", "calling tool", etc.)
 * so we get full IntelliSense on the payload shape, with a fallback
 * JSON renderer for unknown keys.
 *
 * Compare with git history if you're curious how much shell code this
 * replaced — the previous version was ~190 lines of bespoke SSE
 * parsing + state management; this is ~80 lines including the typed
 * `StatusChip` component.
 */
export default function Page(): React.JSX.Element {
    const threadIdRef = useRef(`thread_${Date.now()}`)

    // The route emits `data-status` chips like `{ phase, at }`. Adding
    // the entry here gives `entry.value` a narrow type in the renderer.
    type SupportBotDataMap = {
        status: { phase: 'thinking' | 'tool' | 'finalize'; at: string }
    }

    const transport = aiSdkTransport<SupportBotDataMap>({
        url: '/api/chat',
        bodyBuilder: ({ messages }) => ({
            threadId: threadIdRef.current,
            messages: messages.map(m => ({
                id: m.id,
                role: m.role,
                parts: [{ type: 'text', text: m.text }],
            })),
        }),
    })

    const chat = useMaestroChat<SupportBotDataMap>({ transport })

    const dataRenderers: DataRendererRegistry<SupportBotDataMap> = {
        status: StatusChip,
    }

    return (
        <main
            style={{
                maxWidth: 720,
                margin: '40px auto',
                padding: '0 24px',
                lineHeight: 1.55,
            }}
        >
            <h1 style={{ fontSize: 24, marginBottom: 4 }}>Support copilot</h1>
            <p style={{ color: '#666', marginTop: 0, fontSize: 14 }}>
                Try: <em>summarise TKT-001</em>, <em>escalate TKT-003 to high</em>,{' '}
                <em>search the kb for safari password reset</em>. MCP endpoint at{' '}
                <code>/api/mcp</code>.
            </p>

            <section
                style={{
                    border: '1px solid #ddd',
                    borderRadius: 8,
                    background: '#fff',
                    minHeight: 480,
                    display: 'flex',
                    flexDirection: 'column',
                    marginTop: 16,
                    overflow: 'hidden',
                }}
            >
                <ChatPanel
                    chat={chat}
                    dataRenderers={dataRenderers}
                    placeholder="Ask about a ticket..."
                    emptyState={
                        <div style={{ textAlign: 'center', color: '#888' }}>
                            <p>Ask anything to start.</p>
                        </div>
                    }
                />
            </section>
        </main>
    )
}

/**
 * Typed renderer for `data-status` chips. The `value` prop is narrow
 * thanks to the `SupportBotDataMap` registry passed to
 * `useMaestroChat<...>` + `ChatPanel`.
 */
function StatusChip({
    value,
}: {
    value: { phase: 'thinking' | 'tool' | 'finalize'; at: string }
}): React.JSX.Element {
    const label =
        value.phase === 'thinking'
            ? 'thinking…'
            : value.phase === 'tool'
              ? 'calling tool…'
              : 'finalising…'
    return (
        <span
            style={{
                display: 'inline-block',
                padding: '2px 10px',
                borderRadius: 999,
                background: '#eef2ff',
                color: '#3730a3',
                fontSize: 11,
                fontWeight: 600,
            }}
        >
            {label}
        </span>
    )
}
