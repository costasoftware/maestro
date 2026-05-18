'use client'

import { useCallback, useRef, useState, type FormEvent } from 'react'

interface ChatMessage {
    id: string
    role: 'user' | 'assistant'
    text: string
}

/**
 * Minimal chat UI — text input, streamed transcript. Uses a hand-rolled
 * fetch + EventSource-style reader so we don't drag in `@ai-sdk/react`
 * for what is fundamentally a 50-line widget. The Anthropic / kernel /
 * tool path lives entirely on the server.
 *
 * Production hosts pick a richer UI shell — `@ai-sdk/react`'s
 * `useChat` if they want tool-call rendering for free, or their own
 * primitives if they need design-system fidelity (barbeiro renders
 * tool-call card surfaces, citations, gap-reason chips, etc.).
 */
export default function Page() {
    const [messages, setMessages] = useState<ChatMessage[]>([])
    const [input, setInput] = useState('')
    const [busy, setBusy] = useState(false)
    const threadIdRef = useRef(`thread_${Date.now()}`)

    const send = useCallback(
        async (e: FormEvent) => {
            e.preventDefault()
            const text = input.trim()
            if (!text || busy) return
            setInput('')
            setBusy(true)

            const userMsg: ChatMessage = {
                id: `m_${Date.now()}_u`,
                role: 'user',
                text,
            }
            const assistantId = `m_${Date.now()}_a`
            const assistantMsg: ChatMessage = {
                id: assistantId,
                role: 'assistant',
                text: '',
            }
            // Snapshot for the request payload before the React state update
            // commits — we need the full transcript (history + this turn)
            // to send to the kernel.
            const nextMessages = [...messages, userMsg]
            setMessages([...nextMessages, assistantMsg])

            try {
                const res = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        threadId: threadIdRef.current,
                        messages: nextMessages.map((m) => ({
                            id: m.id,
                            role: m.role,
                            parts: [{ type: 'text', text: m.text }],
                        })),
                    }),
                })

                if (!res.ok || !res.body) {
                    const errMsg =
                        res.status === 429
                            ? '(rate limit reached)'
                            : `(server error ${res.status})`
                    setMessages((prev) =>
                        prev.map((m) => (m.id === assistantId ? { ...m, text: errMsg } : m))
                    )
                    return
                }

                const reader = res.body.getReader()
                const decoder = new TextDecoder()
                let buffer = ''

                // The UI message stream is SSE: lines prefixed with `data: `
                // separated by blank lines. We only render `text-delta`
                // chunks for this minimal UI; data chips (`data-status`,
                // tool-call frames) are ignored.
                while (true) {
                    const { value, done } = await reader.read()
                    if (done) break
                    buffer += decoder.decode(value, { stream: true })
                    let idx
                    while ((idx = buffer.indexOf('\n')) >= 0) {
                        const line = buffer.slice(0, idx).trim()
                        buffer = buffer.slice(idx + 1)
                        if (!line.startsWith('data:')) continue
                        const payload = line.slice(5).trim()
                        if (!payload || payload === '[DONE]') continue
                        try {
                            const parsed = JSON.parse(payload) as { type?: string; delta?: string }
                            if (parsed.type === 'text-delta' && typeof parsed.delta === 'string') {
                                const chunk = parsed.delta
                                setMessages((prev) =>
                                    prev.map((m) =>
                                        m.id === assistantId
                                            ? { ...m, text: m.text + chunk }
                                            : m
                                    )
                                )
                            }
                        } catch {
                            // Ignore malformed frames — defensive only.
                        }
                    }
                }
            } finally {
                setBusy(false)
            }
        },
        [busy, input, messages]
    )

    return (
        <main style={{ maxWidth: 720, margin: '40px auto', padding: '0 24px', lineHeight: 1.55 }}>
            <h1 style={{ fontSize: 24, marginBottom: 4 }}>Support copilot</h1>
            <p style={{ color: '#666', marginTop: 0, fontSize: 14 }}>
                Try: <em>summarise TKT-001</em>, <em>escalate TKT-003 to high</em>,{' '}
                <em>search the kb for safari password reset</em>. MCP endpoint at{' '}
                <code>/api/mcp</code>.
            </p>

            <div
                style={{
                    border: '1px solid #ddd',
                    borderRadius: 6,
                    background: '#fff',
                    minHeight: 320,
                    padding: 16,
                    marginTop: 16,
                }}
            >
                {messages.length === 0 ? (
                    <p style={{ color: '#aaa', fontStyle: 'italic' }}>No messages yet.</p>
                ) : (
                    messages.map((m) => (
                        <div key={m.id} style={{ marginBottom: 16 }}>
                            <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase' }}>
                                {m.role}
                            </div>
                            <div style={{ whiteSpace: 'pre-wrap' }}>
                                {m.text || (m.role === 'assistant' && busy ? '...' : '')}
                            </div>
                        </div>
                    ))
                )}
            </div>

            <form onSubmit={send} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Ask about a ticket..."
                    disabled={busy}
                    style={{
                        flex: 1,
                        padding: '8px 12px',
                        border: '1px solid #ccc',
                        borderRadius: 6,
                        fontSize: 14,
                    }}
                />
                <button
                    type="submit"
                    disabled={busy || !input.trim()}
                    style={{
                        padding: '8px 18px',
                        border: '1px solid #333',
                        background: busy ? '#999' : '#111',
                        color: '#fff',
                        borderRadius: 6,
                        cursor: busy ? 'wait' : 'pointer',
                        fontSize: 14,
                    }}
                >
                    Send
                </button>
            </form>
        </main>
    )
}
