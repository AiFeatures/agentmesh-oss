export type AgentRegisteredEvent = {
  workspace_id: string;
  agent_id: string;
};

export type ClaimCreatedEvent = {
  workspace_id: string;
  claim_id: string;
};

export type HandoffCreatedEvent = {
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
