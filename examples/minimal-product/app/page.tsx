export default function Page() {
    return (
        <main
            style={{
                maxWidth: 720,
                margin: '60px auto',
                padding: '0 24px',
                lineHeight: 1.55,
            }}
        >
            <h1 style={{ fontSize: 28, marginBottom: 8 }}>Maestro example — minimal product</h1>
            <p style={{ color: '#555' }}>
                Smallest possible Next.js host consuming{' '}
                <a href="https://www.npmjs.com/package/@maestro/core">@maestro/core</a>. There is no
                chat UI on purpose — the integration surface is the API route.
            </p>

            <h2 style={{ fontSize: 18, marginTop: 32 }}>Try it</h2>
            <p>
                Set <code>ANTHROPIC_API_KEY</code> in <code>.env</code>, run{' '}
                <code>npm run dev</code>, then POST to <code>/api/chat</code>:
            </p>
            <pre
                style={{
                    background: '#f0f0f0',
                    padding: 16,
                    borderRadius: 6,
                    overflowX: 'auto',
                    fontSize: 13,
                }}
            >{`curl -N -X POST http://localhost:3000/api/chat \\
  -H 'Content-Type: application/json' \\
  -d '{
    "messages": [
      { "id": "1", "role": "user", "parts": [{ "type": "text", "text": "add 12 and 30" }] }
    ]
  }'`}</pre>

            <h2 style={{ fontSize: 18, marginTop: 32 }}>What this demonstrates</h2>
            <ul>
                <li>
                    <code>defineAgentTool</code> with a generic <code>ExampleCtx extends BaseToolContext</code>
                </li>
                <li>
                    <code>buildAiSdkTools</code> wrapping the registry into a Vercel AI SDK
                    <code>ToolSet</code>
                </li>
                <li>In-memory port implementations (TurnStore, AuditStore, MemoryStore, QuotaStore)</li>
                <li>Real Anthropic <code>streamText</code> call with tool calling</li>
            </ul>

            <p style={{ color: '#888', fontSize: 13, marginTop: 32 }}>
                Source:{' '}
                <a href="https://github.com/costasoftware/maestro/tree/main/examples/minimal-product">
                    github.com/costasoftware/maestro/examples/minimal-product
                </a>
            </p>
        </main>
    )
}
