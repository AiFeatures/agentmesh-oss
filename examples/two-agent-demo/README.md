# Two Agent Demo

This example shows two agents coordinating through the hub:

- Agent A claims files and creates a handoff
- Agent B receives events and accepts the handoff

## Prerequisites

- Hub running on `http://localhost:3777`
- Shared secret available at `~/.agentmesh/secret`

## Steps

1. Start hub:

```bash
pnpm dev
```

2. Register two agents (using SDK or API):

- `agent-a` with capability `typescript`
- `agent-b` with capability `testing`

3. Agent A creates claim:

```json
{
  "agent_id": "agent-a",
  "scope": "repo",
  "paths": ["src/**/*.ts"],
  "ttl_seconds": 1800
}
```

4. Agent A creates handoff:

```json
{
  "from_agent_id": "agent-a",
  "to_agent_id": "agent-b",
  "summary": "Please add tests for src/service.ts"
}
```

5. Agent B accepts handoff:

`POST /api/v1/workspaces/default/handoffs/:handoffId/accept`

6. Observe events on WebSocket (`/ws`):

- `claims.updated`
- `handoff.received`
- `handoffs.updated`

## Useful CLI Checks

```bash
node packages/cli/dist/index.js status
node packages/cli/dist/index.js claims
node packages/cli/dist/index.js handoffs --status pending
```
