# Protocol

AgentMesh uses a hub-and-spoke protocol with REST for commands and WebSocket for events.

## Transport

- REST: `http://<host>:3777/api/v1/...`
- WebSocket: `ws://<host>:3777/ws`

## Authentication

All API requests require:

- `Authorization: Bearer <shared-secret>`

The shared secret is read from `~/.agentmesh/secret` on hub and clients.

## Core Entities

- `workspace`: logical boundary for agents and coordination state
- `agent`: registered runtime participant that sends heartbeats
- `claim`: temporary ownership of one or more path patterns
- `handoff`: transfer of context or task between agents
- `blocker`: issue raised by an agent and later resolved

## Coordination Rules

- Claims are evaluated for path conflicts.
- Conflicting active claims return HTTP `409`.
- Claims expire by TTL or explicit release.
- Presence monitor marks agents stale/evicted based on heartbeat freshness.
- Handoffs support direct recipient or capability-based routing.

## Response Conventions

- Success: `200` / `201` with JSON payload
- Validation/auth errors: `4xx` JSON `{ "error": "..." }`
- Conflict: `409` for claim conflict

## Event Model

Hub emits state-change events over WebSocket with shape:

```json
{
  "event": "claims.updated",
  "data": {
    "workspace": "default",
    "claim_id": "clm_abc123"
  },
  "ts": "2026-02-18T10:00:00.000Z"
}
```

See `docs/websocket-events.md` for full list.
