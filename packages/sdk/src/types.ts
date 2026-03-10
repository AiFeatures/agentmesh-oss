export type RegisterPayload = {
  workspace: string;
  agent_id: string;
  agent_type?: string;
  display_name: string;
  model?: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
};

export type BulkRegisterPayload = {
  workspace: string;
  agents: Array<{
    agent_id: string;
    display_name: string;
    model?: string;
    capabilities?: string[];
    metadata?: Record<string, unknown>;
  }>;
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

export type MeshClientOptions = {
  baseUrl?: string;
  wsUrl?: string;
  sharedSecret: string;
  requestTimeoutMs?: number;
  maxReconnectAttempts?: number;
};

// ---- Response types ----

export type OkResponse = { ok: true };

export type RegisterResponse = { ok: true; agent_id: string; workspace_id: string };

export type BulkRegisterResponse = { ok: true; registered: string[]; count: number };

export type ClaimResponse = { claim_id: string };

export type HandoffResponse = { handoff_id: string; to_agent_id: string | null };

export type BlockerResponse = { blocker_id: string };

export type WorkspaceResponse = {
  workspace_id: string;
  display_name: string;
  base_path: string | null;
  created_at: string;
};

export type WorkspaceListResponse = { data: WorkspaceResponse[] };

export type AgentResponse = {
  agent_id: string;
  workspace_id: string;
  display_name: string;
  model: string;
  capabilities: string[];
  status: string;
  last_heartbeat_at: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type PaginatedResponse<T> = { data: T[]; total: number };

export type RouteResponse = { agent_id: string };

export type GcResponse = { released_count: number; released_ids: string[] };

export type OverlapCheckResponse =
  | { overlaps: false }
  | {
      overlaps: true;
      conflicting_claim_id: string;
      conflicting_agent_id: string;
      conflicting_pattern: string;
    };

export type HealthResponse = {
  status: string;
  service: string;
  version: string;
  uptime: number;
  db: string;
  ws_connections: number;
  agents_online: number;
  active_claims: number;
  open_blockers: number;
};

export type MaintenanceResponse = {
  integrity: string;
  page_count: number;
  freelist_count: number;
  vacuumed: boolean;
};
