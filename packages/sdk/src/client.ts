import WebSocket, { type RawData } from "ws";
import type {
  BlockerPayload,
  BlockerResponse,
  BulkRegisterPayload,
  BulkRegisterResponse,
  ClaimPayload,
  ClaimResponse,
  GcResponse,
  HandoffPayload,
  HandoffResponse,
  MeshClientOptions,
  MeshEvent,
  OkResponse,
  OverlapCheckResponse,
  RegisterPayload,
  RegisterResponse,
  RoutePayload,
  RouteResponse,
  WorkspaceListResponse,
  WorkspaceResponse,
} from "./types.js";

export class AgentMeshClient {
  private readonly baseUrl: string;
  private readonly wsUrl: string;
  private readonly sharedSecret: string;
  private readonly requestTimeoutMs: number;
  private ws: WebSocket | null = null;
  private wsClosed = true;
  private wsBackoffMs = 1000;
  private wsReconnectAttempts = 0;
  private readonly maxReconnectAttempts: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MeshClientOptions) {
    this.baseUrl = options.baseUrl ?? "http://localhost:3777";
    this.wsUrl = options.wsUrl ?? "ws://localhost:3777/ws";
    this.sharedSecret = options.sharedSecret;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 20;
  }

  async register(payload: RegisterPayload): Promise<RegisterResponse> {
    return await this.request(`/api/v1/workspaces/${payload.workspace}/agents/register`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async bulkRegister(payload: BulkRegisterPayload): Promise<BulkRegisterResponse> {
    return await this.request(`/api/v1/workspaces/${payload.workspace}/agents/bulk-register`, {
      method: "POST",
      body: JSON.stringify({ agents: payload.agents }),
    });
  }

  async heartbeat(workspace: string, agentId: string): Promise<OkResponse> {
    return await this.request(`/api/v1/workspaces/${workspace}/agents/heartbeat`, {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId }),
    });
  }

  async getWorkspace(workspace: string): Promise<WorkspaceResponse> {
    return await this.request(`/api/v1/workspaces/${workspace}`, {
      method: "GET",
    });
  }

  async listWorkspaces(): Promise<WorkspaceListResponse> {
    return await this.request("/api/v1/workspaces", { method: "GET" });
  }

  async createWorkspace(
    workspace: string,
    displayName: string,
    basePath?: string,
  ): Promise<{ workspace_id: string }> {
    return await this.request("/api/v1/workspaces", {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspace,
        display_name: displayName,
        base_path: basePath,
      }),
    });
  }

  async getWorkspaceStats(workspace: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/stats`, { method: "GET" });
  }

  async updateWorkspace(
    workspace: string,
    updates: { display_name?: string; base_path?: string },
  ): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
  }

  async getAgent(workspace: string, agentId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/agents/${agentId}`, {
      method: "GET",
    });
  }

  async listAgents(
    workspace: string,
    opts?: { status?: string; limit?: number; offset?: number },
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return await this.request(`/api/v1/workspaces/${workspace}/agents${qs ? `?${qs}` : ""}`, {
      method: "GET",
    });
  }

  async getHandoff(workspace: string, handoffId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/handoffs/${handoffId}`, {
      method: "GET",
    });
  }

  async listHandoffs(
    workspace: string,
    opts?: { status?: string; limit?: number; offset?: number },
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return await this.request(`/api/v1/workspaces/${workspace}/handoffs${qs ? `?${qs}` : ""}`, {
      method: "GET",
    });
  }

  async getHandoffStats(workspace: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/handoffs/stats`, {
      method: "GET",
    });
  }

  async deregisterAgent(workspace: string, agentId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/agents/${agentId}`, {
      method: "DELETE",
    });
  }

  async getCapabilities(workspace: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/capabilities`, {
      method: "GET",
    });
  }

  async updateAgentStatus(
    workspace: string,
    agentId: string,
    status: "online" | "idle" | "blocked",
  ): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/agents/${agentId}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
  }

  async getAgentHistory(
    workspace: string,
    agentId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return await this.request(
      `/api/v1/workspaces/${workspace}/agents/${agentId}/history${qs ? `?${qs}` : ""}`,
      { method: "GET" },
    );
  }

  async getAgentActivity(workspace: string, agentId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/agents/${agentId}/activity`, {
      method: "GET",
    });
  }

  async getAgentStatusHistory(
    workspace: string,
    agentId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return await this.request(
      `/api/v1/workspaces/${workspace}/agents/${agentId}/status-history${qs ? `?${qs}` : ""}`,
      { method: "GET" },
    );
  }

  async searchAgents(
    workspace: string,
    body: { capabilities: string[]; status?: string; tag?: string },
  ): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/agents/search`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async addHandoffNote(
    workspace: string,
    handoffId: string,
    body: { author_id: string; content: string },
  ): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/handoffs/${handoffId}/notes`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async getHandoffNotes(workspace: string, handoffId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/handoffs/${handoffId}/notes`, {
      method: "GET",
    });
  }

  async getHandoffChain(workspace: string, handoffId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/handoffs/${handoffId}/chain`, {
      method: "GET",
    });
  }

  async watchBlocker(workspace: string, blockerId: string, agentId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/blockers/${blockerId}/watchers`, {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId }),
    });
  }

  async getBlockerWatchers(workspace: string, blockerId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/blockers/${blockerId}/watchers`, {
      method: "GET",
    });
  }

  async batchClaimStatus(workspace: string, claimIds: string[]): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/claims/batch-status`, {
      method: "POST",
      body: JSON.stringify({ claim_ids: claimIds }),
    });
  }

  async getAgentMetadataHistory(
    workspace: string,
    agentId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return await this.request(
      `/api/v1/workspaces/${workspace}/agents/${agentId}/metadata-history${qs ? `?${qs}` : ""}`,
      { method: "GET" },
    );
  }

  async getAuditSummary(workspace: string, hours?: number): Promise<unknown> {
    const qs = hours ? `?hours=${hours}` : "";
    return await this.request(`/api/v1/workspaces/${workspace}/audit/summary${qs}`, {
      method: "GET",
    });
  }

  async bulkDeregisterAgents(workspace: string, agentIds: string[]): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/agents/bulk-deregister`, {
      method: "POST",
      body: JSON.stringify({ agent_ids: agentIds }),
    });
  }

  async getAgentGroups(workspace: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/agents/groups`, {
      method: "GET",
    });
  }

  async detectClaimConflicts(workspace: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/claims/detect-conflicts`, {
      method: "GET",
    });
  }

  async snapshotMetrics(workspace: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/metrics/snapshot`, {
      method: "POST",
    });
  }

  async getMetricsHistory(workspace: string, limit?: number): Promise<unknown> {
    const qs = limit ? `?limit=${limit}` : "";
    return await this.request(`/api/v1/workspaces/${workspace}/metrics/history${qs}`, {
      method: "GET",
    });
  }

  async addBlockerComment(
    workspace: string,
    blockerId: string,
    authorId: string,
    content: string,
  ): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/blockers/${blockerId}/comments`, {
      method: "POST",
      body: JSON.stringify({ author_id: authorId, content }),
    });
  }

  async getBlockerComments(workspace: string, blockerId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/blockers/${blockerId}/comments`, {
      method: "GET",
    });
  }

  async getClaimRenewalHistory(workspace: string, claimId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/claims/${claimId}/renewal-history`, {
      method: "GET",
    });
  }

  async evictIdleAgents(workspace: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/agents/evict-idle`, {
      method: "POST",
    });
  }

  startHeartbeat(workspace: string, agentId: string, intervalMs = 10000): () => void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.heartbeat(workspace, agentId).catch(() => undefined);
    }, intervalMs);
    return () => this.stopHeartbeat();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async claim(payload: ClaimPayload): Promise<ClaimResponse> {
    return await this.request(`/api/v1/workspaces/${payload.workspace}/claims`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async releaseClaim(workspace: string, claimId: string): Promise<OkResponse> {
    return await this.request(`/api/v1/workspaces/${workspace}/claims/${claimId}/release`, {
      method: "POST",
    });
  }

  async renewClaim(workspace: string, claimId: string, ttlSeconds = 1800): Promise<OkResponse> {
    return await this.request(`/api/v1/workspaces/${workspace}/claims/${claimId}/renew`, {
      method: "POST",
      body: JSON.stringify({ ttl_seconds: ttlSeconds }),
    });
  }

  async transferClaim(workspace: string, claimId: string, toAgentId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/claims/${claimId}/transfer`, {
      method: "POST",
      body: JSON.stringify({ to_agent_id: toAgentId }),
    });
  }

  async getClaimStats(workspace: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/claims/stats`, {
      method: "GET",
    });
  }

  async batchReleaseClaims(workspace: string, claimIds: string[]): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/claims/batch-release`, {
      method: "POST",
      body: JSON.stringify({ claim_ids: claimIds }),
    });
  }

  async batchRenewClaims(
    workspace: string,
    claims: Array<{ claim_id: string; ttl_seconds?: number }>,
  ): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/claims/batch-renew`, {
      method: "POST",
      body: JSON.stringify({ claims }),
    });
  }

  async handoff(payload: HandoffPayload): Promise<HandoffResponse> {
    return await this.request(`/api/v1/workspaces/${payload.workspace}/handoffs`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async acceptHandoff(workspace: string, handoffId: string): Promise<OkResponse> {
    return await this.request(`/api/v1/workspaces/${workspace}/handoffs/${handoffId}/accept`, {
      method: "POST",
    });
  }

  async rejectHandoff(workspace: string, handoffId: string): Promise<OkResponse> {
    return await this.request(`/api/v1/workspaces/${workspace}/handoffs/${handoffId}/reject`, {
      method: "POST",
    });
  }

  async retryHandoff(workspace: string, handoffId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/handoffs/${handoffId}/retry`, {
      method: "POST",
    });
  }

  async deleteWorkspace(workspace: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}`, {
      method: "DELETE",
    });
  }

  async archiveWorkspace(workspace: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/archive`, {
      method: "POST",
    });
  }

  async unarchiveWorkspace(workspace: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/unarchive`, {
      method: "POST",
    });
  }

  async escalateBlocker(workspace: string, blockerId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/blockers/${blockerId}/escalate`, {
      method: "POST",
    });
  }

  async getAuditLog(
    workspace: string,
    opts?: { action?: string; limit?: number; offset?: number },
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.action) params.set("action", opts.action);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return await this.request(`/api/v1/workspaces/${workspace}/audit${qs ? `?${qs}` : ""}`, {
      method: "GET",
    });
  }

  async blocker(payload: BlockerPayload): Promise<BlockerResponse> {
    return await this.request(`/api/v1/workspaces/${payload.workspace}/blockers`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async updateAgentCapabilities(
    workspace: string,
    agentId: string,
    capabilities: string[],
  ): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/agents/${agentId}/capabilities`, {
      method: "PATCH",
      body: JSON.stringify({ capabilities }),
    });
  }

  async updateAgentMetadata(
    workspace: string,
    agentId: string,
    metadata: Record<string, unknown>,
  ): Promise<{ ok: true; metadata: Record<string, unknown> }> {
    return await this.request(`/api/v1/workspaces/${workspace}/agents/${agentId}/metadata`, {
      method: "PATCH",
      body: JSON.stringify({ metadata }),
    });
  }

  async getWorkspaceMetrics(workspace: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/metrics`, {
      method: "GET",
    });
  }

  async getBlocker(workspace: string, blockerId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/blockers/${blockerId}`, {
      method: "GET",
    });
  }

  async listBlockers(
    workspace: string,
    opts?: { status?: string; limit?: number; offset?: number },
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return await this.request(`/api/v1/workspaces/${workspace}/blockers${qs ? `?${qs}` : ""}`, {
      method: "GET",
    });
  }

  async resolveBlocker(
    workspace: string,
    blockerId: string,
    resolution: string,
    resolvedBy?: string,
  ): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/blockers/${blockerId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ note: resolution, resolved_by: resolvedBy }),
    });
  }

  async getBlockerStats(workspace: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/blockers/stats`, {
      method: "GET",
    });
  }

  async getClaim(workspace: string, claimId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/claims/${claimId}`, {
      method: "GET",
    });
  }

  async listClaims(
    workspace: string,
    opts?: { status?: string; limit?: number; offset?: number },
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts?.status) params.set("status", opts.status);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return await this.request(`/api/v1/workspaces/${workspace}/claims${qs ? `?${qs}` : ""}`, {
      method: "GET",
    });
  }

  async route(payload: RoutePayload): Promise<RouteResponse> {
    return await this.request(`/api/v1/workspaces/${payload.workspace}/route`, {
      method: "POST",
      body: JSON.stringify({ capability: payload.capability }),
    });
  }

  onEvent(handler: (event: MeshEvent) => void): () => void {
    this.wsClosed = false;

    const connect = () => {
      if (this.wsClosed) {
        return;
      }

      this.ws = new WebSocket(this.wsUrl);
      this.ws.on("open", () => {
        this.wsBackoffMs = 1000;
        this.wsReconnectAttempts = 0;
      });
      this.ws.on("message", (data: RawData) => {
        try {
          handler(JSON.parse(data.toString()) as MeshEvent);
        } catch {
          handler({ event: "connected", raw: data.toString() });
        }
      });
      this.ws.on("close", () => {
        if (!this.wsClosed) {
          this.wsReconnectAttempts++;
          if (this.wsReconnectAttempts > this.maxReconnectAttempts) {
            this.wsClosed = true;
            return;
          }
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(connect, this.wsBackoffMs);
          this.wsBackoffMs = Math.min(this.wsBackoffMs * 2, 30000);
        }
      });
    };

    connect();

    return () => {
      this.disconnect();
    };
  }

  disconnect(): void {
    this.wsClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.stopHeartbeat();
  }

  subscribeWorkspace(workspace: string): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ type: "subscribe", workspace }));
    }
  }

  unsubscribeWorkspace(workspace: string): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ type: "unsubscribe", workspace }));
    }
  }

  filterEvents(events: string[]): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ type: "filter_events", events }));
    }
  }

  clearEventFilter(): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ type: "clear_filter" }));
    }
  }

  async garbageCollectClaims(workspace: string): Promise<GcResponse> {
    return await this.request(`/api/v1/workspaces/${workspace}/claims/gc`, {
      method: "POST",
    });
  }

  async checkClaimOverlap(workspace: string, paths: string[]): Promise<OverlapCheckResponse> {
    return await this.request(`/api/v1/workspaces/${workspace}/claims/check-overlap`, {
      method: "POST",
      body: JSON.stringify({ paths }),
    });
  }

  async forceReleaseAllClaims(
    workspace: string,
    opts?: { agent_id?: string; scope?: string },
  ): Promise<GcResponse> {
    return await this.request(`/api/v1/workspaces/${workspace}/claims/force-release-all`, {
      method: "POST",
      body: JSON.stringify(opts ?? {}),
    });
  }

  async exportWorkspace(workspace: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/export`, {
      method: "GET",
    });
  }

  async getWorkspaceSettings(workspace: string): Promise<Record<string, unknown>> {
    return await this.request(`/api/v1/workspaces/${workspace}/settings`, {
      method: "GET",
    });
  }

  async updateWorkspaceSettings(
    workspace: string,
    settings: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return await this.request(`/api/v1/workspaces/${workspace}/settings`, {
      method: "PATCH",
      body: JSON.stringify(settings),
    });
  }

  private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.sharedSecret}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });

      if (!response.ok) {
        throw new Error(`request failed: ${response.status} ${await response.text()}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}
