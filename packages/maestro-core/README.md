# @costasoftware/maestro-core

Runtime kernel for the Maestro agent platform.

`0.0.1` ships only `ToolEnvelope` — the uniform success/failure shape every tool returns. Adapters, ports, and `defineAgentTool` land in subsequent releases.

## Install

```bash
pnpm add @costasoftware/maestro-core
```

## Usage

```ts
import { ok, err, isOk, type ToolEnvelope } from '@costasoftware/maestro-core'

function lookup(id: string): ToolEnvelope<{ name: string }> {
    if (id === 'missing') return err('NOT_FOUND', 'no such record')
    return ok({ name: 'example' })
}
```

See repo [DESIGN.md](https://github.com/costasoftware/maestro/blob/main/DESIGN.md) for roadmap.
