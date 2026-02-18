import type { AgentMeshAdapter } from "../interface.js";

export class ConsoleAdapter implements AgentMeshAdapter {
  async initialize(): Promise<void> {
    console.log("[console-adapter] initialized");
  }

  async shutdown(): Promise<void> {
    console.log("[console-adapter] shutdown");
  }

  async healthCheck(): Promise<{ ok: boolean; details?: string }> {
    return { ok: true, details: "console-adapter ready" };
  }

  async onAgentRegistered(event: { workspace_id: string; agent_id: string }): Promise<void> {
    console.log("[console-adapter] agent registered", event);
  }

  async onClaimCreated(event: { workspace_id: string; claim_id: string }): Promise<void> {
    console.log("[console-adapter] claim created", event);
  }

  async onHandoffCreated(event: { workspace_id: string; handoff_id: string }): Promise<void> {
    console.log("[console-adapter] handoff created", event);
  }

  async onBlockerCreated(event: { workspace_id: string; blocker_id: string }): Promise<void> {
    console.log("[console-adapter] blocker created", event);
  }

  async onBlockerResolved(event: { workspace_id: string; blocker_id: string }): Promise<void> {
    console.log("[console-adapter] blocker resolved", event);
  }
}
