import type {
  AgentDeregisteredEvent,
  AgentRegisteredEvent,
  AgentStatusChangedEvent,
  BlockerCreatedEvent,
  BlockerResolvedEvent,
  ClaimCreatedEvent,
  ClaimReleasedEvent,
  HandoffAcceptedEvent,
  HandoffCreatedEvent,
  HandoffRejectedEvent,
} from "./types.js";

export interface AgentMeshAdapter {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<{ ok: boolean; details?: string }>;
  onAgentRegistered(event: AgentRegisteredEvent): Promise<void>;
  onAgentStatusChanged?(event: AgentStatusChangedEvent): Promise<void>;
  onAgentDeregistered?(event: AgentDeregisteredEvent): Promise<void>;
  onClaimCreated(event: ClaimCreatedEvent): Promise<void>;
  onClaimReleased?(event: ClaimReleasedEvent): Promise<void>;
  onHandoffCreated(event: HandoffCreatedEvent): Promise<void>;
  onHandoffAccepted?(event: HandoffAcceptedEvent): Promise<void>;
  onHandoffRejected?(event: HandoffRejectedEvent): Promise<void>;
  onBlockerCreated(event: BlockerCreatedEvent): Promise<void>;
  onBlockerResolved(event: BlockerResolvedEvent): Promise<void>;
}

export * from "./types.js";
