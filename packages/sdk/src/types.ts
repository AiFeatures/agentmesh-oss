export type RegisterPayload = {
  workspace: string;
  agent_id: string;
  agent_type?: string;
  display_name: string;
  model?: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
};

export type ClaimPayload = {
  workspace: string;
  agent_id: string;
  scope: string;
  paths: string[];
  ttl_seconds?: number;
};

export type HandoffPayload = {
  workspace: string;
  from_agent_id: string;
  to_agent_id?: string;
  capability_tag?: string;
  summary: string;
  context?: Record<string, unknown>;
  timeout_seconds?: number;
};

export type BlockerPayload = {
  workspace: string;
  agent_id: string;
  title: string;
  details?: string;
  severity: "low" | "medium" | "high" | "critical";
  deadline_seconds?: number;
};

export type RoutePayload = {
  workspace: string;
  capability: string;
};

export type MeshEventName =
  | "connected"
  | "agents.updated"
  | "agents.heartbeat"
  | "handoff.received"
  | "handoffs.updated"
  | "claims.updated"
  | "claims.conflict"
  | "claims.expired"
  | "handoffs.expired"
  | "blocker.created"
  | "blocker.resolved"
  | "blockers.sla_breached"
  | "presence.updated"
  | "audit.logged";

export type MeshEvent = {
  event: MeshEventName | string;
  [key: string]: unknown;
};
