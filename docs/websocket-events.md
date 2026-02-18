# WebSocket Events

Connect to `ws://localhost:3777/ws`.

Each message is JSON:

```json
{
  "event": "agents.updated",
  "data": {
    "workspace": "default",
    "agent_id": "agent-a"
  },
  "ts": "2026-02-18T10:00:00.000Z"
}
```

## Connection Event

- `connected`

Sent immediately after socket registration.

## Agent Events

- `agents.updated`
  - `workspace`, `agent_id`
- `agents.heartbeat`
  - `workspace`, `agent_id`

## Claim Events

- `claims.updated`
  - `workspace`, `claim_id`, `status`
  - or `workspace`, `released`, `status` for bulk GC release
- `claims.conflict`
  - `workspace`, `claim_id`, `agent_id`, `path_pattern`, `requestedBy`
- `claims.expired`
  - emitted by scheduler when active claims expire

## Handoff Events

- `handoff.received`
  - `workspace`, `handoff_id`, `to_agent_id`
- `handoffs.updated`
  - `workspace`, `handoff_id`, `status`

## Blocker Events

- `blocker.created`
  - `workspace`, `blocker_id`, `severity`
- `blocker.resolved`
  - `workspace`, `blocker_id`

## Presence and Audit Events

- `presence.updated`
  - emitted when agents are marked stale or evicted
- `audit.logged`
  - emitted when an audit row is written

## Reconnect Behavior

`@agentmesh/sdk` reconnects with exponential backoff from 1s to 30s.
