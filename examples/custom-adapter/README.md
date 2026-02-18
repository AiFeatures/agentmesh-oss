# Custom Adapter Example

This example outlines a minimal event bridge that maps hub WebSocket events to an `AgentMeshAdapter` implementation.

## Goal

- Subscribe to hub events
- Dispatch typed payloads to adapter handlers
- Keep adapter lifecycle explicit (`initialize`/`shutdown`)

## Skeleton

```ts
import { AgentMeshClient } from "@agentmesh/sdk";
import { ConsoleAdapter } from "@agentmesh/adapter-interface/src/examples/console-adapter.js";

const adapter = new ConsoleAdapter();
await adapter.initialize();

const client = new AgentMeshClient({
  sharedSecret: process.env.AGENTMESH_SHARED_SECRET!,
  baseUrl: process.env.AGENTMESH_BASE_URL ?? "http://localhost:3777",
  wsUrl: process.env.AGENTMESH_WS_URL ?? "ws://localhost:3777/ws",
});

const stop = client.onEvent(async (evt) => {
  if (evt.event === "agents.updated") {
    const data = evt.data as { workspace: string; agent_id: string };
    await adapter.onAgentRegistered({ workspace_id: data.workspace, agent_id: data.agent_id });
  }
});

process.on("SIGINT", async () => {
  stop();
  await adapter.shutdown();
  process.exit(0);
});
```

## Notes

- Add retries and dead-letter handling for external systems.
- Keep event handlers idempotent.
- Validate payload shape before dispatching to adapters.
