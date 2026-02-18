# Architecture

AgentMesh is a lightweight coordination hub for independent agents.

```text
             +--------------------+
             |  Human Operator    |
             +---------+----------+
                       |
                       v
  +--------------------+---------------------+
  |              AgentMesh Hub               |
  |  - REST API (Fastify)                    |
  |  - WebSocket event gateway               |
  |  - Claim conflict resolver               |
  |  - Capability router                     |
  |  - Presence + claim-expiry cron jobs     |
  +--------------------+---------------------+
                       |
                       v
             +--------------------+
             | SQLite (WAL mode)  |
             +--------------------+

  Agent A <----REST/WS----> Hub <----REST/WS----> Agent B
  Agent C <----REST/WS----> Hub <----REST/WS----> Agent D
```

## SDK Example

```ts
import { AgentMeshClient } from "@agentmesh/sdk";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const secret = readFileSync(path.join(os.homedir(), ".agentmesh", "secret"), "utf8").trim();
const client = new AgentMeshClient({ sharedSecret: secret });

await client.register({
  workspace: "default",
  agent_id: "ts-agent-1",
  display_name: "TypeScript Agent",
  capabilities: ["typescript", "testing"],
});

client.onEvent((event) => {
  console.log("event", event.event, event);
});

client.startHeartbeat("default", "ts-agent-1", 10_000);
```
