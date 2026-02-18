import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import WebSocket from "ws";

type JsonValue = Record<string, unknown>;

const baseUrl = process.env.AGENTMESH_BASE_URL ?? "http://127.0.0.1:3791";
const wsUrl = process.env.AGENTMESH_WS_URL ?? "ws://127.0.0.1:3791/ws";
const secretPath = path.join(os.homedir(), ".agentmesh", "secret");
const secret = readFileSync(secretPath, "utf8").trim();

const workspace = `battle-${Date.now().toString(36)}`;
const agentA = `${workspace}-agent-a`;
const agentB = `${workspace}-agent-b`;
const agentC = `${workspace}-agent-c`;

const events = new Set<string>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: JsonValue }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${secret}`,
  };
  if (body) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let json: JsonValue = {};
  if (text.length > 0) {
    json = JSON.parse(text) as JsonValue;
  }

  return { status: response.status, json };
}

async function openWs(): Promise<WebSocket> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.once("open", () => resolve(ws));
    ws.once("error", (error) => reject(error));
    ws.on("message", (payload) => {
      try {
        const parsed = JSON.parse(payload.toString()) as { event?: string };
        if (parsed.event) {
          events.add(parsed.event);
        }
      } catch {
        // ignore invalid event payloads
      }
    });
  });
}

function requireStatus(actual: number, expected: number, label: string): void {
  assert.equal(actual, expected, `${label}: expected ${expected}, got ${actual}`);
}

async function main(): Promise<void> {
  const ws = await openWs();

  const createWorkspace = await request("POST", "/api/v1/workspaces", {
    workspace_id: workspace,
    display_name: "Battle Test Workspace",
  });
  requireStatus(createWorkspace.status, 201, "workspace create");

  for (const agent of [
    { id: agentA, name: "Battle Agent A", capabilities: ["typescript"] },
    { id: agentB, name: "Battle Agent B", capabilities: ["testing"] },
    { id: agentC, name: "Battle Agent C", capabilities: ["ops"] },
  ]) {
    const res = await request("POST", `/api/v1/workspaces/${workspace}/agents/register`, {
      agent_id: agent.id,
      display_name: agent.name,
      capabilities: agent.capabilities,
    });
    requireStatus(res.status, 201, `register ${agent.id}`);
  }

  const heartbeat = await request("POST", `/api/v1/workspaces/${workspace}/agents/heartbeat`, {
    agent_id: agentA,
  });
  requireStatus(heartbeat.status, 200, "agent heartbeat");

  const claimA = await request("POST", `/api/v1/workspaces/${workspace}/claims`, {
    agent_id: agentA,
    scope: "repo",
    paths: ["src/**"],
    ttl_seconds: 120,
  });
  requireStatus(claimA.status, 201, "claim a create");
  const claimAId = String(claimA.json.claim_id ?? "");
  assert.ok(claimAId.startsWith("clm_"), "claim a id is returned");

  const conflictingClaim = await request("POST", `/api/v1/workspaces/${workspace}/claims`, {
    agent_id: agentB,
    scope: "repo",
    paths: ["src/routes/**"],
    ttl_seconds: 120,
  });
  requireStatus(conflictingClaim.status, 409, "claim conflict");

  const claimB = await request("POST", `/api/v1/workspaces/${workspace}/claims`, {
    agent_id: agentB,
    scope: "docs",
    paths: ["docs/**"],
    ttl_seconds: 120,
  });
  requireStatus(claimB.status, 201, "claim b create");
  const claimBId = String(claimB.json.claim_id ?? "");
  assert.ok(claimBId.startsWith("clm_"), "claim b id is returned");

  const renewClaim = await request("POST", `/api/v1/workspaces/${workspace}/claims/${claimBId}/renew`, {
    ttl_seconds: 300,
  });
  requireStatus(renewClaim.status, 200, "renew claim b");

  const releaseClaim = await request("POST", `/api/v1/workspaces/${workspace}/claims/${claimAId}/release`);
  requireStatus(releaseClaim.status, 200, "release claim a");

  const route = await request("POST", `/api/v1/workspaces/${workspace}/route`, {
    capability: "testing",
  });
  requireStatus(route.status, 200, "capability route");
  assert.equal(route.json.agent_id, agentB, "capability route chooses testing agent");

  const createHandoff = await request("POST", `/api/v1/workspaces/${workspace}/handoffs`, {
    from_agent_id: agentA,
    capability_tag: "testing",
    summary: "Please cover service tests",
    context: { source: "battle-test" },
  });
  requireStatus(createHandoff.status, 201, "create handoff");
  const handoffId = String(createHandoff.json.handoff_id ?? "");
  assert.ok(handoffId.startsWith("hnd_"), "handoff id is returned");

  const pendingHandoffs = await request("GET", `/api/v1/workspaces/${workspace}/handoffs?status=pending`);
  requireStatus(pendingHandoffs.status, 200, "list pending handoffs");
  const pendingRows = Array.isArray(pendingHandoffs.json.data)
    ? (pendingHandoffs.json.data as Array<Record<string, unknown>>)
    : [];
  assert.ok(pendingRows.some((row) => row.handoff_id === handoffId), "pending handoff exists");

  const acceptHandoff = await request(
    "POST",
    `/api/v1/workspaces/${workspace}/handoffs/${handoffId}/accept`,
  );
  requireStatus(acceptHandoff.status, 200, "accept handoff");

  const createBlocker = await request("POST", `/api/v1/workspaces/${workspace}/blockers`, {
    agent_id: agentC,
    title: "Need access token",
    details: "Cannot call remote API",
    severity: "critical",
  });
  requireStatus(createBlocker.status, 201, "create blocker");
  const blockerId = String(createBlocker.json.blocker_id ?? "");
  assert.ok(blockerId.startsWith("blk_"), "blocker id is returned");

  const resolveBlocker = await request(
    "POST",
    `/api/v1/workspaces/${workspace}/blockers/${blockerId}/resolve`,
    {
      option: "use-fallback-token",
      note: "Temporary fallback configured",
      resolved_by: "operator",
    },
  );
  requireStatus(resolveBlocker.status, 200, "resolve blocker");

  const statusAgents = await request("GET", `/api/v1/workspaces/${workspace}/agents`);
  const statusClaims = await request("GET", `/api/v1/workspaces/${workspace}/claims`);
  const statusBlockers = await request("GET", `/api/v1/workspaces/${workspace}/blockers`);
  requireStatus(statusAgents.status, 200, "list agents");
  requireStatus(statusClaims.status, 200, "list claims");
  requireStatus(statusBlockers.status, 200, "list blockers");

  const agentRows = Array.isArray(statusAgents.json.data) ? statusAgents.json.data : [];
  const claimRows = Array.isArray(statusClaims.json.data) ? statusClaims.json.data : [];
  const blockerRows = Array.isArray(statusBlockers.json.data) ? statusBlockers.json.data : [];
  assert.equal(agentRows.length, 3, "agent count is correct");
  assert.equal(claimRows.length, 2, "claim count is correct");
  assert.equal(blockerRows.length, 1, "blocker count is correct");

  const runGc = await request("POST", `/api/v1/workspaces/${workspace}/claims/gc`);
  requireStatus(runGc.status, 200, "claim gc");

  await sleep(500);
  ws.close();

  const requiredEvents = [
    "connected",
    "agents.updated",
    "agents.heartbeat",
    "claims.updated",
    "claims.conflict",
    "handoff.received",
    "handoffs.updated",
    "blocker.created",
    "blocker.resolved",
  ];

  const missing = requiredEvents.filter((eventName) => !events.has(eventName));
  assert.equal(missing.length, 0, `missing websocket events: ${missing.join(", ")}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        workspace,
        agents: agentRows.length,
        claims: claimRows.length,
        blockers: blockerRows.length,
        events: Array.from(events).sort(),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
