export type AgentRegisteredEvent = {
  workspace_id: string;
  agent_id: string;
};

export type AgentStatusChangedEvent = {
  workspace_id: string;
  agent_id: string;
  status: string;
};

export type AgentDeregisteredEvent = {
  workspace_id: string;
  agent_id: string;
};

export type ClaimCreatedEvent = {
  workspace_id: string;
  claim_id: string;
};

export type ClaimReleasedEvent = {
  workspace_id: string;
  claim_id: string;
  status: "released" | "force_released" | "expired";
};

export type HandoffCreatedEvent = {
  workspace_id: string;
  handoff_id: string;
};

export type HandoffAcceptedEvent = {
  workspace_id: string;
  handoff_id: string;
};

export type HandoffRejectedEvent = {
  workspace_id: string;
  handoff_id: string;
};

export type BlockerCreatedEvent = {
  workspace_id: string;
  blocker_id: string;
};

export type BlockerResolvedEvent = {
  workspace_id: string;
  blocker_id: string;
};
