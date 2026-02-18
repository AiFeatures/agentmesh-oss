# API Reference

Base URL: `http://localhost:3777`

All endpoints require `Authorization: Bearer <shared-secret>`.

## Health

- `GET /health`

Response:

```json
{ "status": "ok", "service": "agentmesh-hub" }
```

## Workspaces

- `GET /api/v1/workspaces`
- `POST /api/v1/workspaces`

Create body:

```json
{
  "workspace_id": "optional-id",
  "display_name": "My Workspace",
  "base_path": "/path/to/repo"
}
```

## Agents

- `POST /api/v1/workspaces/:workspace/agents/register`
- `POST /api/v1/workspaces/:workspace/agents/heartbeat`
- `GET /api/v1/workspaces/:workspace/agents`

Register body:

```json
{
  "agent_id": "agent-a",
  "display_name": "Agent A",
  "agent_type": "worker",
  "model": "custom",
  "capabilities": ["typescript"],
  "metadata": { "team": "core" }
}
```

Heartbeat body:

```json
{ "agent_id": "agent-a" }
```

## Claims

- `POST /api/v1/workspaces/:workspace/claims`
- `GET /api/v1/workspaces/:workspace/claims`
- `POST /api/v1/workspaces/:workspace/claims/:claimId/release`
- `POST /api/v1/workspaces/:workspace/claims/:claimId/renew`
- `POST /api/v1/workspaces/:workspace/claims/gc`

Create body:

```json
{
  "agent_id": "agent-a",
  "scope": "repo",
  "paths": ["src/**/*.ts"],
  "ttl_seconds": 1800
}
```

Conflict response (`409`):

```json
{
  "error": "Claim conflict",
  "claim_id": "clm_existing",
  "agent_id": "agent-b",
  "path_pattern": "src/app.ts"
}
```

Renew body:

```json
{ "ttl_seconds": 1800 }
```

## Handoffs

- `POST /api/v1/workspaces/:workspace/handoffs`
- `POST /api/v1/workspaces/:workspace/handoffs/:handoffId/accept`
- `GET /api/v1/workspaces/:workspace/handoffs?status=pending`

Create body:

```json
{
  "from_agent_id": "agent-a",
  "to_agent_id": "agent-b",
  "capability_tag": "testing",
  "summary": "Need integration test coverage",
  "context": { "branch": "feature/x" }
}
```

`to_agent_id` is optional; if missing, capability routing is used when `capability_tag` is provided.

## Blockers

- `POST /api/v1/workspaces/:workspace/blockers`
- `POST /api/v1/workspaces/:workspace/blockers/:blockerId/resolve`
- `GET /api/v1/workspaces/:workspace/blockers`

Create body:

```json
{
  "agent_id": "agent-a",
  "title": "CI is failing",
  "details": "Type errors after refactor",
  "severity": "high"
}
```

Resolve body:

```json
{
  "option": "retry",
  "note": "Fixed by updating lockfile",
  "resolved_by": "operator"
}
```

## Routing

- `POST /api/v1/workspaces/:workspace/route`

Body:

```json
{ "capability": "testing" }
```

Response:

```json
{ "agent_id": "agent-b" }
```
