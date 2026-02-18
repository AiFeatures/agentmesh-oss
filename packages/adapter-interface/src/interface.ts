import type {
  AgentRegisteredEvent,
  BlockerCreatedEvent,
  BlockerResolvedEvent,
  ClaimCreatedEvent,
  HandoffCreatedEvent,
} from "./types.js";

export interface AgentMeshAdapter {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; details?: string }>;
  onAgentRegistered(event: AgentRegisteredEvent): Promise<void>;
  onClaimCreated(event: ClaimCreatedEvent): Promise<void>;
  onHandoffCreated(event: HandoffCreatedEvent): Promise<void>;
  onBlockerCreated(event: BlockerCreatedEvent): Promise<void>;
  onBlockerResolved(event: BlockerResolvedEvent): Promise<void>;
}

export * from "./types.js";
