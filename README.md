# AgentMesh OSS

AgentMesh OSS is a lightweight multi-agent coordination hub.

Creator website: `https://rajushahi.com`.

It includes only the open-source core:

- `@agentmesh/hub`: REST + WebSocket coordination server
- `@agentmesh/cli`: terminal client for day-to-day coordination operations
- `@agentmesh/sdk`: TypeScript client for agents and tools
- `@agentmesh/adapter-interface`: adapter contract for custom integrations

## Features

- Shared-secret API auth
- Workspace + agent registry
- Path-based claims with conflict detection
- Handoffs (direct or capability-routed)
- Blocker tracking + resolution flow
- WebSocket event stream for state changes
- SQLite storage with migrations and WAL mode

## Quick Start

Prerequisites:

- Node.js 22+
- pnpm 9+

Install and run locally:

```bash
pnpm install
pnpm dev
```

Hub runs on `http://localhost:3777`.

The first run creates a shared secret at `~/.agentmesh/secret`.

In another terminal:

```bash
pnpm --filter @agentmesh/cli build
node packages/cli/dist/index.js init --hub http://localhost:3777 --workspace default
node packages/cli/dist/index.js status
```

## Docker

```bash
docker compose -f docker/docker-compose.yml up --build
```

Hub will be available at `http://localhost:3777`.

## CLI Commands

Main commands:

- `mesh init`
- `mesh workspace create`
- `mesh workspace list`
- `mesh agents`
- `mesh claims`
- `mesh handoffs`
- `mesh blockers`
- `mesh resolve <blocker_id> <option>`
- `mesh status`
- `mesh gc`

## SDK Example

```ts
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentMeshClient } from "@agentmesh/sdk";

const secret = readFileSync(path.join(os.homedir(), ".agentmesh", "secret"), "utf8").trim();

const client = new AgentMeshClient({
  baseUrl: "http://localhost:3777",
  wsUrl: "ws://localhost:3777/ws",
  sharedSecret: secret,
});

await client.register({
  workspace: "default",
  agent_id: "agent-a",
  display_name: "Agent A",
  capabilities: ["typescript", "testing"],
});

client.onEvent((event) => {
  console.log(event.event, event);
});
```

## Documentation

- `docs/architecture.md`
- `docs/protocol.md`
- `docs/api-reference.md`
- `docs/websocket-events.md`
- `docs/writing-adapters.md`
- `docs/security.md`

## Contribute

Contributions are welcome. Please open issues, propose improvements, and send PRs.

- Read `CONTRIBUTING.md`
- Run local checks before opening a PR:

```bash
pnpm lint
pnpm test
pnpm build
```

- Run the battle scenario yourself to validate real agent coordination:

```bash
AGENTMESH_BASE_URL="http://127.0.0.1:3791" AGENTMESH_WS_URL="ws://127.0.0.1:3791/ws" pnpm battle:test
```

## Project Structure

```text
packages/
  hub/
  cli/
  sdk/
  adapter-interface/
docs/
examples/
docker/
```

## Development

```bash
pnpm build
pnpm lint
pnpm test
```

## Battle Test

Run an end-to-end multi-agent scenario against a local hub:

```bash
PORT=3791 AGENTMESH_SQLITE_PATH="/tmp/agentmesh-oss-battle.sqlite" pnpm --filter @agentmesh/hub start
```

In another terminal:

```bash
AGENTMESH_BASE_URL="http://127.0.0.1:3791" AGENTMESH_WS_URL="ws://127.0.0.1:3791/ws" pnpm battle:test
```

## License

MIT. See `LICENSE`.

---

## iAiFy Fork Notes

> This section is maintained by the iAiFy enterprise and documents what the AiFeatures fork actually supports. If this contradicts upstream text above, this section wins for iAiFy operators.

**Status:** Active fork (maintained).
**Enterprise:** iAiFy (Stockholm).
**Upstream sync:** Managed via [Ai-road-4-You/fork-sync](https://github.com/Ai-road-4-You) — upstream changes are reviewed before merge; divergence is intentional where documented.
**Support scope:** Only the build/run paths documented below are supported internally. Other upstream surfaces are best-effort.

### Supported commands

Run only the commands verified in this repo's current manifest (see `package.json` / `pyproject.toml` / `Cargo.toml` for the authoritative list).

### CI/CD

This repo uses (or is migrating to) the shared enterprise CI/CD:

- Reusable workflows: [Ai-road-4-You/enterprise-ci-cd@v1](https://github.com/Ai-road-4-You/enterprise-ci-cd)
- Governance: [Ai-road-4-You/governance](https://github.com/Ai-road-4-You/governance)
- Documentation standard: [`docs/documentation-standard.md`](https://github.com/Ai-road-4-You/governance/blob/main/docs/documentation-standard.md)

### Contributing

Internal contributors follow the iAiFy governance rules: conventional commits, PR review required, no force-push to `main`. See [Ai-road-4-You/governance](https://github.com/Ai-road-4-You/governance).

### License

See `LICENSE` in this repo. iAiFy-originated changes are MIT unless the upstream license requires otherwise.
