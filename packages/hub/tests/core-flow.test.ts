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

test("workspace delete cascades to agents and claims", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-del-${suffix}`;
  const agentId = `agent-del-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Delete Test" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "Del Agent" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, scope: "backend", paths: ["src/**"] },
  });

  const delRes = await app.inject({
    method: "DELETE",
    url: `/api/v1/workspaces/${workspaceId}`,
    headers: auth,
  });
  assert.equal(delRes.statusCode, 200);
  assert.deepStrictEqual(delRes.json(), { ok: true });

  const listRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/agents`,
    headers: auth,
  });
  const agents = listRes.json() as { data: unknown[] };
  assert.equal(agents.data.length, 0);

  const del404 = await app.inject({
    method: "DELETE",
    url: `/api/v1/workspaces/${workspaceId}`,
    headers: auth,
  });
  assert.equal(del404.statusCode, 404);

  await app.close();
});

test("audit log endpoint returns workspace events", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-audit-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Audit Test" },
  });

  const auditRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/audit`,
    headers: auth,
  });
  assert.equal(auditRes.statusCode, 200);
  const audit = auditRes.json() as { data: Array<{ action: string }> };
  assert.ok(audit.data.length >= 1);
  assert.ok(audit.data.some((e) => e.action === "workspace.create"));

  const filteredRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/audit?action=workspace.create&limit=1`,
    headers: auth,
  });
  const filtered = filteredRes.json() as { data: Array<{ action: string }> };
  assert.equal(filtered.data.length, 1);
  assert.equal(filtered.data[0].action, "workspace.create");

  await app.close();
});

test("batch claim release releases multiple claims at once", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-batch-${suffix}`;
  const agentId = `agent-batch-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Batch Test" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "Batch Agent" },
  });

  const ids: string[] = [];
  for (const scope of ["backend", "frontend"]) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/claims`,
      headers: { ...auth, "content-type": "application/json" },
      payload: { agent_id: agentId, scope, paths: [`${scope}/**`] },
    });
    assert.equal(res.statusCode, 201);
    ids.push((res.json() as { claim_id: string }).claim_id);
  }

  const batchRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims/batch-release`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { claim_ids: [...ids, "nonexistent-id"] },
  });
  assert.equal(batchRes.statusCode, 200);
  const body = batchRes.json() as { released: string[]; not_found: string[] };
  assert.equal(body.released.length, 2);
  assert.equal(body.not_found.length, 1);
  assert.equal(body.not_found[0], "nonexistent-id");

  await app.close();
});

test("handoff accepts timeout_seconds parameter", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-hto-${suffix}`;
  const agentId = `agent-hto-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Timeout Test" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "Timeout Agent" },
  });

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/handoffs`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      from_agent_id: agentId,
      summary: "Timeout handoff",
      timeout_seconds: 3600,
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { handoff_id: string };
  assert.ok(body.handoff_id);

  await app.close();
});

test("capabilities introspection returns capability-to-agent map", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-caps-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Caps Test" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      agent_id: `agent-cap-a-${suffix}`,
      display_name: "Cap Agent A",
      capabilities: ["typescript", "python"],
    },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      agent_id: `agent-cap-b-${suffix}`,
      display_name: "Cap Agent B",
      capabilities: ["typescript"],
    },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/capabilities`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const caps = res.json() as { data: Array<{ capability: string; agents: string[]; count: number }> };
  const ts = caps.data.find((c) => c.capability === "typescript");
  assert.ok(ts);
  assert.equal(ts.count, 2);
  const py = caps.data.find((c) => c.capability === "python");
  assert.ok(py);
  assert.equal(py.count, 1);

  await app.close();
});

test("agent deregister removes agent and cascades claims", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-dereg-${suffix}`;
  const agentId = `agent-dereg-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Dereg Test" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "Dereg Agent", capabilities: ["test"] },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, scope: "backend", paths: ["src/**"] },
  });

  const delRes = await app.inject({
    method: "DELETE",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}`,
    headers: auth,
  });
  assert.equal(delRes.statusCode, 200);
  assert.deepStrictEqual(delRes.json(), { ok: true });

  const del404 = await app.inject({
    method: "DELETE",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}`,
    headers: auth,
  });
  assert.equal(del404.statusCode, 404);

  await app.close();
});

test("blocker accepts deadline_seconds parameter", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-sla-${suffix}`;
  const agentId = `agent-sla-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "SLA Test" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "SLA Agent" },
  });

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/blockers`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      agent_id: agentId,
      title: "SLA blocker",
      severity: "high",
      deadline_seconds: 3600,
    },
  });
  assert.equal(res.statusCode, 201);
  assert.ok((res.json() as { blocker_id: string }).blocker_id);

  await app.close();
});

test("agent status update changes agent status", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-status-${suffix}`;
  const agentId = `agent-status-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Status Test" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "Status Agent" },
  });

  const patchRes = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}/status`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { status: "idle" },
  });
  assert.equal(patchRes.statusCode, 200);
  assert.deepStrictEqual(patchRes.json(), { ok: true, status: "idle" });

  const badStatus = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}/status`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { status: "invalid" },
  });
  assert.equal(badStatus.statusCode, 400);

  await app.close();
});
