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

// ---- Core entity responses (for typed SDK methods) ----

export type ClaimDetailResponse = {
  claim_id: string;
  workspace_id: string;
  agent_id: string;
  scope: string;
  status: string;
  paths: string[];
  ttl_seconds: number;
  priority: string;
  renewal_count: number;
  created_at: string;
  expires_at: string;
  released_at: string | null;
  dependencies: string[];
};

export type HandoffDetailResponse = {
  handoff_id: string;
  workspace_id: string;
  from_agent_id: string;
  to_agent_id: string | null;
  route_mode: string;
  capability_tag: string | null;
  summary: string;
  context: Record<string, unknown> | null;
  status: string;
  retry_count: number;
  max_retries: number;
  priority: string;
  created_at: string;
  updated_at: string;
  timeline: AuditEntry[];
};

export type BlockerDetailResponse = {
  blocker_id: string;
  workspace_id: string;
  agent_id: string;
  title: string;
  details: string | null;
  severity: string;
  status: string;
  resolved_by: string | null;
  resolution_note: string | null;
  escalation_level: number;
  deadline_at: string | null;
  created_at: string;
  resolved_at: string | null;
  dependencies: string[];
};

export type AuditEntry = {
  audit_id: number;
  workspace_id: string | null;
  actor_type: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  request_id: string | null;
  payload: Record<string, unknown> | null;
  created_at: string;
};

export type WorkspaceStatsResponse = {
  workspace_id: string;
  agents: { total: number; online: number };
  claims: { active: number };
  handoffs: { total: number; pending: number };
  blockers: { total: number; open: number };
};

export type DashboardResponse = {
  workspace_id: string;
  agents: { total: number; online: number; idle: number; stale: number; evicted: number };
  claims: { active: number; released: number; expired: number };
  handoffs: { pending: number; accepted: number; rejected: number };
  blockers: { open: number; resolved: number; critical: number };
};

export type CapabilitiesResponse = {
  data: Array<{ agent_id: string; capabilities: string[]; status: string }>;
};

export type ExportResponse = Record<string, unknown>;

export type SettingsResponse = Record<string, unknown>;

/** Generic response for analytics/reporting endpoints */
export type AnalyticsResponse = Record<string, unknown>;

/** Paginated list of audit entries */
export type AuditLogResponse = { data: AuditEntry[] };

/** Generic {ok: true} with optional extra fields */
export type ActionResponse = { ok: true; [key: string]: unknown };

export type BatchReleaseResponse = { released: string[]; not_found: string[] };

export type AgentActivityResponse = {
  agent_id: string;
  claims: number;
  handoffs_initiated: number;
  handoffs_received: number;
  blockers: number;
};

export type ClaimStatsResponse = {
  total: number;
  active: number;
  released: number;
  expired: number;
  force_released: number;
};

export type BlockerStatsResponse = {
  total: number;
  open: number;
  resolved: number;
  by_severity: Record<string, number>;
};

export type HandoffStatsResponse = {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
};

export type AgentHealthResponse = {
  agent_id: string;
  status: string;
  health_score: number;
  last_heartbeat_at: string;
  active_claims: number;
  uptime_seconds: number;
};
