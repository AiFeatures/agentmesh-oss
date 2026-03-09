import WebSocket, { type RawData } from "ws";
import type {
  BlockerPayload,
  ClaimPayload,
  HandoffPayload,
  MeshEvent,
  RegisterPayload,
  RoutePayload,
} from "./types.js";

type MeshClientOptions = {
  baseUrl?: string;
  wsUrl?: string;
  sharedSecret: string;
  requestTimeoutMs?: number;
};

export class AgentMeshClient {
  private readonly baseUrl: string;
  private readonly wsUrl: string;
  private readonly sharedSecret: string;
  private readonly requestTimeoutMs: number;
  private ws: WebSocket | null = null;
  private wsClosed = true;
  private wsBackoffMs = 1000;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MeshClientOptions) {
    this.baseUrl = options.baseUrl ?? "http://localhost:3777";
    this.wsUrl = options.wsUrl ?? "ws://localhost:3777/ws";
    this.sharedSecret = options.sharedSecret;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
  }

  async register(payload: RegisterPayload): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${payload.workspace}/agents/register`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async heartbeat(workspace: string, agentId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/agents/heartbeat`, {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId }),
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

  async claim(payload: ClaimPayload): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${payload.workspace}/claims`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async releaseClaim(workspace: string, claimId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/claims/${claimId}/release`, {
      method: "POST",
    });
  }

  async renewClaim(workspace: string, claimId: string, ttlSeconds = 1800): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/claims/${claimId}/renew`, {
      method: "POST",
      body: JSON.stringify({ ttl_seconds: ttlSeconds }),
    });
  }

  async handoff(payload: HandoffPayload): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${payload.workspace}/handoffs`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async acceptHandoff(workspace: string, handoffId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/handoffs/${handoffId}/accept`, {
      method: "POST",
    });
  }

  async rejectHandoff(workspace: string, handoffId: string): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${workspace}/handoffs/${handoffId}/reject`, {
      method: "POST",
    });
  }

  async blocker(payload: BlockerPayload): Promise<unknown> {
    return await this.request(`/api/v1/workspaces/${payload.workspace}/blockers`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async route(payload: RoutePayload): Promise<unknown> {
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

  private async request(path: string, init: RequestInit): Promise<unknown> {
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
