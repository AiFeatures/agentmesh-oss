import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { runMigrations } from "../src/db/index.js";
import { getSharedSecret } from "../src/security/secret.js";

test("register, claim, handoff, blocker core flow", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `demo-${suffix}`;
  const agentId = `agent-a-${suffix}`;

  const workspaceRes = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Demo" },
  });
  assert.equal(workspaceRes.statusCode, 201);

  const registerRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      agent_id: agentId,
      display_name: "Agent A",
      capabilities: ["typescript"],
    },
  });
  assert.equal(registerRes.statusCode, 201);

  const claimRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, scope: "backend", paths: ["src/**"] },
  });
  assert.equal(claimRes.statusCode, 201);

  const handoffRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/handoffs`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      from_agent_id: agentId,
      capability_tag: "typescript",
      summary: "Please review this module.",
    },
  });
  assert.equal(handoffRes.statusCode, 201);

  const blockerRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/blockers`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      agent_id: agentId,
      title: "Need API contract",
      severity: "high",
    },
  });
  assert.equal(blockerRes.statusCode, 201);

  await app.close();
});

test("unauthenticated requests are rejected with 401", async () => {
  runMigrations();
  const app = buildApp();

  const noAuth = await app.inject({
    method: "GET",
    url: "/api/v1/workspaces/default/agents",
  });
  assert.equal(noAuth.statusCode, 401);

  const badAuth = await app.inject({
    method: "GET",
    url: "/api/v1/workspaces/default/agents",
    headers: { authorization: "Bearer wrong-secret" },
  });
  assert.equal(badAuth.statusCode, 401);

  await app.close();
});

test("GET handoffs rejects invalid status query param", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-qp-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "QP Test" },
  });

  const badStatus = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/handoffs?status=invalid`,
    headers: auth,
  });
  assert.equal(badStatus.statusCode, 400);

  const goodStatus = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/handoffs?status=pending`,
    headers: auth,
  });
  assert.equal(goodStatus.statusCode, 200);

  await app.close();
});

test("agent register rejects oversized metadata", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-meta-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Meta Test" },
  });

  const bigMeta: Record<string, string> = {};
  for (let i = 0; i < 60; i++) {
    bigMeta[`key_${i}`] = `value_${i}`;
  }

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      agent_id: `agent-meta-${suffix}`,
      display_name: "Big Meta Agent",
      metadata: bigMeta,
    },
  });
  assert.equal(res.statusCode, 400);

  await app.close();
});

test("handoff reject endpoint changes status to rejected", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-rej-${suffix}`;
  const agentId = `agent-rej-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Reject Test" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "Rej Agent" },
  });

  const handoffRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/handoffs`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      from_agent_id: agentId,
      summary: "Please reject this.",
    },
  });
  assert.equal(handoffRes.statusCode, 201);
  const handoffId = (handoffRes.json() as { handoff_id: string }).handoff_id;

  const rejectRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/handoffs/${handoffId}/reject`,
    headers: auth,
  });
  assert.equal(rejectRes.statusCode, 200);
  assert.deepStrictEqual(rejectRes.json(), { ok: true });

  const listRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/handoffs?status=rejected`,
    headers: auth,
  });
  const list = listRes.json() as { data: Array<{ handoff_id: string }> };
  assert.equal(list.data.length, 1);
  assert.equal(list.data[0].handoff_id, handoffId);

  await app.close();
});

test("workspace stats endpoint returns counts", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-stats-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Stats Test" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: `agent-st-${suffix}`, display_name: "Stats Agent" },
  });

  const statsRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/stats`,
    headers: auth,
  });
  assert.equal(statsRes.statusCode, 200);
  const stats = statsRes.json() as {
    workspace_id: string;
    agents: { total: number; online: number };
  };
  assert.equal(stats.workspace_id, workspaceId);
  assert.equal(stats.agents.total, 1);
  assert.equal(stats.agents.online, 1);

  await app.close();
});

test("health check returns db and uptime info", async () => {
  runMigrations();
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { status: string; db: string; uptime: number };
  assert.equal(body.status, "ok");
  assert.equal(body.db, "connected");
  assert.equal(typeof body.uptime, "number");

  await app.close();
});
