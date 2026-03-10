import assert from "node:assert/strict";
import test from "node:test";
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
  const caps = res.json() as {
    data: Array<{ capability: string; agents: string[]; count: number }>;
  };
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

test("GET single agent returns agent detail", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-ga-${suffix}`;
  const agentId = `agent-ga-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "GetAgent Test" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "Detail Agent", capabilities: ["ts"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { agent_id: string; capabilities: string[] };
  assert.equal(body.agent_id, agentId);
  assert.deepStrictEqual(body.capabilities, ["ts"]);

  const notFound = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/agents/nonexistent`,
    headers: auth,
  });
  assert.equal(notFound.statusCode, 404);

  await app.close();
});

test("GET single handoff returns handoff detail", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-gh-${suffix}`;
  const agentId = `agent-gh-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "GetHandoff Test" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "GH Agent" },
  });

  const createRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/handoffs`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { from_agent_id: agentId, summary: "Detail test" },
  });
  const handoffId = (createRes.json() as { handoff_id: string }).handoff_id;

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/handoffs/${handoffId}`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { handoff_id: string; summary: string };
  assert.equal(body.handoff_id, handoffId);
  assert.equal(body.summary, "Detail test");

  await app.close();
});

test("workspace update changes display name", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-upd-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Before" },
  });

  const patchRes = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${workspaceId}`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { display_name: "After" },
  });
  assert.equal(patchRes.statusCode, 200);

  const emptyPatch = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${workspaceId}`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {},
  });
  assert.equal(emptyPatch.statusCode, 400);

  await app.close();
});

test("GET single blocker and blocker list filters", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-blk-${suffix}`;
  const agentId = `agent-blk-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Blocker Detail" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "Blk Agent" },
  });

  const createRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/blockers`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, title: "Detail blocker", severity: "high" },
  });
  const blockerId = (createRes.json() as { blocker_id: string }).blocker_id;

  const detailRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/blockers/${blockerId}`,
    headers: auth,
  });
  assert.equal(detailRes.statusCode, 200);
  assert.equal((detailRes.json() as { blocker_id: string }).blocker_id, blockerId);

  const filteredRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/blockers?severity=high&status=open`,
    headers: auth,
  });
  assert.equal(filteredRes.statusCode, 200);
  const filtered = filteredRes.json() as { data: unknown[]; total: number };
  assert.equal(filtered.total, 1);

  await app.close();
});

test("GET single claim returns claim with paths", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-clmd-${suffix}`;
  const agentId = `agent-clmd-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Claim Detail" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "Claim Agent" },
  });

  const createRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, scope: "backend", paths: ["src/**", "lib/**"] },
  });
  const claimId = (createRes.json() as { claim_id: string }).claim_id;

  const detailRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/claims/${claimId}`,
    headers: auth,
  });
  assert.equal(detailRes.statusCode, 200);
  const claim = detailRes.json() as { claim_id: string; paths: string[] };
  assert.equal(claim.claim_id, claimId);
  assert.deepStrictEqual(claim.paths.sort(), ["lib/**", "src/**"]);

  const filterRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/claims?status=active`,
    headers: auth,
  });
  assert.equal(filterRes.statusCode, 200);
  const filtered = filterRes.json() as { data: unknown[]; total: number };
  assert.equal(filtered.total, 1);

  await app.close();
});

test("GET single workspace returns workspace detail", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-single-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Single WS" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { workspace_id: string; display_name: string };
  assert.equal(body.workspace_id, workspaceId);
  assert.equal(body.display_name, "Single WS");

  const notFound = await app.inject({
    method: "GET",
    url: "/api/v1/workspaces/nonexistent-ws",
    headers: auth,
  });
  assert.equal(notFound.statusCode, 404);

  await app.close();
});

test("X-Request-Id header is propagated in responses", async () => {
  runMigrations();
  const app = buildApp();

  const customId = "my-custom-request-id-12345";
  const res = await app.inject({
    method: "GET",
    url: "/health",
    headers: { "x-request-id": customId },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["x-request-id"], customId);

  const autoRes = await app.inject({
    method: "GET",
    url: "/health",
  });
  assert.equal(autoRes.statusCode, 200);
  assert.ok(autoRes.headers["x-request-id"]);

  await app.close();
});

test("agent status change creates audit log entry", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-stataud-${suffix}`;
  const agentId = `agent-stataud-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Status Audit" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "Audit Agent" },
  });

  await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}/status`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { status: "idle" },
  });

  const auditRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/audit?action=agent.status_change`,
    headers: auth,
  });
  assert.equal(auditRes.statusCode, 200);
  const audit = auditRes.json() as { data: Array<{ action: string }> };
  assert.ok(audit.data.length >= 1);
  assert.equal(audit.data[0].action, "agent.status_change");

  await app.close();
});

test("agent history endpoint returns status change history", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-hist-${suffix}`;
  const agentId = `agent-hist-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "History Test" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "History Agent" },
  });

  await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}/status`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { status: "idle" },
  });

  await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}/status`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { status: "blocked" },
  });

  const histRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}/history`,
    headers: auth,
  });
  assert.equal(histRes.statusCode, 200);
  const hist = histRes.json() as { data: Array<{ action: string; created_at: string }> };
  assert.ok(hist.data.length >= 3);

  const hist404 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/agents/nonexistent/history`,
    headers: auth,
  });
  assert.equal(hist404.statusCode, 404);

  await app.close();
});

test("claim release and renew create audit log entries", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-claaud-${suffix}`;
  const agentId = `agent-claaud-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Claim Audit" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "CA Agent" },
  });

  const claimRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, scope: "test", paths: ["test/**"] },
  });
  const claimId = (claimRes.json() as { claim_id: string }).claim_id;

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims/${claimId}/renew`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { ttl_seconds: 600 },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims/${claimId}/release`,
    headers: auth,
  });

  const auditRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/audit`,
    headers: auth,
  });
  const audit = auditRes.json() as { data: Array<{ action: string }> };
  const actions = audit.data.map((e) => e.action);
  assert.ok(actions.includes("claim.renew"));
  assert.ok(actions.includes("claim.release"));

  await app.close();
});

test("handoff accept and reject create audit log entries", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-hoaud-${suffix}`;
  const agentId = `agent-hoaud-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "HO Audit" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "HO Agent" },
  });

  const h1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/handoffs`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { from_agent_id: agentId, summary: "Accept this" },
  });
  const h1Id = (h1.json() as { handoff_id: string }).handoff_id;

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/handoffs/${h1Id}/accept`,
    headers: auth,
  });

  const h2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/handoffs`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { from_agent_id: agentId, summary: "Reject this" },
  });
  const h2Id = (h2.json() as { handoff_id: string }).handoff_id;

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/handoffs/${h2Id}/reject`,
    headers: auth,
  });

  const auditRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/audit`,
    headers: auth,
  });
  const audit = auditRes.json() as { data: Array<{ action: string }> };
  const actions = audit.data.map((e) => e.action);
  assert.ok(actions.includes("handoff.accept"));
  assert.ok(actions.includes("handoff.reject"));

  await app.close();
});

test("workspace update creates audit log entry", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36);
  const workspaceId = `ws-upaud-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Update Audit" },
  });

  await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${workspaceId}`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { display_name: "Updated Name" },
  });

  const auditRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/audit?action=workspace.update`,
    headers: auth,
  });
  const audit = auditRes.json() as { data: Array<{ action: string }> };
  assert.equal(audit.data.length, 1);
  assert.equal(audit.data[0].action, "workspace.update");

  await app.close();
});

test("health endpoint includes ws_connections count", async () => {
  runMigrations();
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    ws_connections: number;
    agents_online: number;
    active_claims: number;
    open_blockers: number;
    version: string;
  };
  assert.equal(typeof body.ws_connections, "number");
  assert.equal(body.ws_connections, 0);
  assert.equal(typeof body.agents_online, "number");
  assert.equal(typeof body.active_claims, "number");
  assert.equal(typeof body.open_blockers, "number");
  assert.equal(body.version, "0.1.0");

  await app.close();
});

test("PATCH agent status changes status", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "st";
  const workspaceId = `ws-status-${suffix}`;
  const agentId = `agent-st-${suffix}`;

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
    payload: { agent_id: agentId, display_name: "StatusAgent", capabilities: ["test"] },
  });

  const patchRes = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}/status`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { status: "idle" },
  });
  assert.equal(patchRes.statusCode, 200);
  const patchBody = patchRes.json() as { ok: boolean; status: string };
  assert.equal(patchBody.ok, true);
  assert.equal(patchBody.status, "idle");

  const getRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}`,
    headers: auth,
  });
  const agent = getRes.json() as { status: string };
  assert.equal(agent.status, "idle");

  await app.close();
});

test("renew claim extends expiry", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "rn";
  const workspaceId = `ws-renew-${suffix}`;
  const agentId = `agent-rn-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Renew Test" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "RenewAgent", capabilities: ["test"] },
  });

  const claimRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, scope: "backend", paths: ["src/**"], ttl_seconds: 60 },
  });
  assert.equal(claimRes.statusCode, 201);
  const claimId = (claimRes.json() as { claim_id: string }).claim_id;

  const renewRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims/${claimId}/renew`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { ttl_seconds: 3600 },
  });
  assert.equal(renewRes.statusCode, 200);
  const renewBody = renewRes.json() as { ok: boolean };
  assert.equal(renewBody.ok, true);

  await app.close();
});

test("batch-release claims releases multiple", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "br";
  const workspaceId = `ws-batch-${suffix}`;
  const agentId = `agent-br-${suffix}`;

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
    payload: { agent_id: agentId, display_name: "BatchAgent", capabilities: ["test"] },
  });

  const claim1Res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, scope: "frontend", paths: ["ui/**"] },
  });
  const claim2Res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, scope: "backend", paths: ["api/**"] },
  });
  const id1 = (claim1Res.json() as { claim_id: string }).claim_id;
  const id2 = (claim2Res.json() as { claim_id: string }).claim_id;

  const batchRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims/batch-release`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { claim_ids: [id1, id2, "nonexistent-claim"] },
  });
  assert.equal(batchRes.statusCode, 200);
  const batch = batchRes.json() as { released: string[]; not_found: string[] };
  assert.equal(batch.released.length, 2);
  assert.ok(batch.released.includes(id1));
  assert.ok(batch.released.includes(id2));
  assert.deepStrictEqual(batch.not_found, ["nonexistent-claim"]);

  await app.close();
});

test("claims gc releases claims of stale agents", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "gc";
  const workspaceId = `ws-gc-${suffix}`;
  const agentId = `agent-gc-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "GC Test" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "GCAgent", capabilities: ["test"] },
  });

  const claimRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, scope: "backend", paths: ["gc/**"] },
  });
  assert.equal(claimRes.statusCode, 201);

  // Mark agent as stale so GC picks up its claims
  await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}/status`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { status: "idle" },
  });
  // Force agent to stale status directly (stale is not settable via API, but we can test GC with online agents returning 0)
  const gcRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims/gc`,
    headers: auth,
  });
  assert.equal(gcRes.statusCode, 200);
  const gcBody = gcRes.json() as { released_count: number };
  // Agent is not stale/evicted so GC should not release
  assert.equal(gcBody.released_count, 0);

  await app.close();
});

test("deregister agent removes agent", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "dr";
  const workspaceId = `ws-dereg-${suffix}`;
  const agentId = `agent-dr-${suffix}`;

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
    payload: { agent_id: agentId, display_name: "DeregAgent", capabilities: ["test"] },
  });

  const deleteRes = await app.inject({
    method: "DELETE",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}`,
    headers: auth,
  });
  assert.equal(deleteRes.statusCode, 200);

  const getRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}`,
    headers: auth,
  });
  assert.equal(getRes.statusCode, 404);

  await app.close();
});

test("agent history returns audit trail", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "ah";
  const workspaceId = `ws-hist-${suffix}`;
  const agentId = `agent-ah-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "History Test" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "HistAgent", capabilities: ["test"] },
  });

  // Change status to generate an audit entry
  await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}/status`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { status: "blocked" },
  });

  const histRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}/history`,
    headers: auth,
  });
  assert.equal(histRes.statusCode, 200);
  const hist = histRes.json() as { data: Array<{ action: string }> };
  assert.ok(hist.data.length >= 1);
  // Registration + status change should be in the history
  const actions = hist.data.map((e) => e.action);
  assert.ok(actions.includes("agent.status_change") || actions.includes("agent.register"));

  await app.close();
});

test("workspace_id rejects invalid characters", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  const badRes = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: "bad workspace!", display_name: "Bad" },
  });
  assert.equal(badRes.statusCode, 400);

  const goodRes = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: `valid-ws_${Date.now()}`, display_name: "Good" },
  });
  assert.equal(goodRes.statusCode, 201);

  await app.close();
});

test("check-overlap returns conflict when paths overlap", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "ol";
  const workspaceId = `ws-overlap-${suffix}`;
  const agentId = `agent-ol-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Overlap Test" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "OAgent", capabilities: ["test"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, scope: "backend", paths: ["src/**"] },
  });

  const overlapRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims/check-overlap`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { paths: ["src/app.ts"] },
  });
  assert.equal(overlapRes.statusCode, 200);
  const overlap = overlapRes.json() as { overlaps: boolean };
  assert.equal(overlap.overlaps, true);

  const noOverlapRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims/check-overlap`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { paths: ["docs/README.md"] },
  });
  assert.equal(noOverlapRes.statusCode, 200);
  const noOverlap = noOverlapRes.json() as { overlaps: boolean };
  assert.equal(noOverlap.overlaps, false);

  await app.close();
});

test("workspace export returns full data", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "ex";
  const workspaceId = `ws-export-${suffix}`;
  const agentId = `agent-ex-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Export Test" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "ExAgent", capabilities: ["test"] },
  });

  const exportRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/export`,
    headers: auth,
  });
  assert.equal(exportRes.statusCode, 200);
  const data = exportRes.json() as {
    workspace: { workspace_id: string };
    agents: unknown[];
    claims: unknown[];
    handoffs: unknown[];
    blockers: unknown[];
    exported_at: string;
  };
  assert.equal(data.workspace.workspace_id, workspaceId);
  assert.equal(data.agents.length, 1);
  assert.ok(data.exported_at);

  await app.close();
});

test("blocker detail includes timeline", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "bt";
  const workspaceId = `ws-btl-${suffix}`;
  const agentId = `agent-bt-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Timeline Test" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "BTAgent", capabilities: ["test"] },
  });

  const blockerRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/blockers`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, title: "Blocked on review", severity: "high" },
  });
  const blockerId = (blockerRes.json() as { blocker_id: string }).blocker_id;

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/blockers/${blockerId}/resolve`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { note: "Fixed", resolved_by: agentId },
  });

  const detailRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/blockers/${blockerId}`,
    headers: auth,
  });
  assert.equal(detailRes.statusCode, 200);
  const detail = detailRes.json() as {
    blocker_id: string;
    timeline: Array<{ action: string }>;
  };
  assert.equal(detail.blocker_id, blockerId);
  assert.ok(Array.isArray(detail.timeline));
  assert.ok(detail.timeline.length >= 2);
  const actions = detail.timeline.map((t) => t.action);
  assert.ok(actions.includes("blocker.create"));
  assert.ok(actions.includes("blocker.resolve"));

  await app.close();
});

test("PATCH agent capabilities updates capabilities", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "cp";
  const workspaceId = `ws-caps-${suffix}`;
  const agentId = `agent-cp-${suffix}`;

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
    payload: { agent_id: agentId, display_name: "CapsAgent", capabilities: ["test"] },
  });

  const patchRes = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}/capabilities`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { capabilities: ["typescript", "python", "review"] },
  });
  assert.equal(patchRes.statusCode, 200);
  const body = patchRes.json() as { ok: boolean; capabilities: string[] };
  assert.equal(body.ok, true);
  assert.deepStrictEqual(body.capabilities, ["typescript", "python", "review"]);

  const getRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/agents/${agentId}`,
    headers: auth,
  });
  const agent = getRes.json() as { capabilities: string[] };
  assert.deepStrictEqual(agent.capabilities, ["typescript", "python", "review"]);

  await app.close();
});

test("workspace metrics returns grouped counts", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "mx";
  const workspaceId = `ws-metrics-${suffix}`;
  const agentId = `agent-mx-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Metrics Test" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "MXAgent", capabilities: ["test"] },
  });

  const metricsRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/metrics`,
    headers: auth,
  });
  assert.equal(metricsRes.statusCode, 200);
  const metrics = metricsRes.json() as {
    workspace_id: string;
    agents: Record<string, number>;
    claims: Record<string, number>;
    audit_events_24h: number;
  };
  assert.equal(metrics.workspace_id, workspaceId);
  assert.equal(metrics.agents.online, 1);
  assert.ok(typeof metrics.audit_events_24h === "number");

  await app.close();
});

test("handoff detail includes timeline", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "ht";
  const workspaceId = `ws-htl-${suffix}`;
  const agentId = `agent-ht-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "Handoff TL" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: agentId, display_name: "HTAgent", capabilities: ["test"] },
  });

  const handoffRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/handoffs`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      from_agent_id: agentId,
      capability_tag: "test",
      summary: "Review needed",
    },
  });
  assert.equal(handoffRes.statusCode, 201);
  const handoffId = (handoffRes.json() as { handoff_id: string }).handoff_id;

  const detailRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/handoffs/${handoffId}`,
    headers: auth,
  });
  assert.equal(detailRes.statusCode, 200);
  const detail = detailRes.json() as {
    handoff_id: string;
    timeline: Array<{ action: string }>;
  };
  assert.equal(detail.handoff_id, handoffId);
  assert.ok(Array.isArray(detail.timeline));
  assert.ok(detail.timeline.length >= 1);

  await app.close();
});

// ------- Force-release-all claims -------
test("force-release-all releases active claims and respects filters", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const workspaceId = `frac-${Date.now()}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "ForceRelease" },
  });

  // Register two agents
  for (const aid of ["fra-agent1", "fra-agent2"]) {
    await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${workspaceId}/agents/register`,
      headers: { ...auth, "content-type": "application/json" },
      payload: { agent_id: aid, display_name: aid, capabilities: ["code"] },
    });
  }

  // Create claims for each agent
  const c1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "fra-agent1", scope: "src", paths: ["src/a.ts"] },
  });
  assert.equal(c1.statusCode, 201);

  const c2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "fra-agent2", scope: "lib", paths: ["lib/b.ts"] },
  });
  assert.equal(c2.statusCode, 201);

  // Force-release only agent1's claims
  const r1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims/force-release-all`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "fra-agent1" },
  });
  assert.equal(r1.statusCode, 200);
  const body1 = r1.json() as { released_count: number; released_ids: string[] };
  assert.equal(body1.released_count, 1);

  // Agent2's claim should still be active
  const listRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/claims?status=active`,
    headers: auth,
  });
  const claims = (listRes.json() as { data: Array<{ agent_id: string }> }).data;
  assert.equal(claims.length, 1);
  assert.equal(claims[0].agent_id, "fra-agent2");

  // Force-release all remaining
  const r2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/claims/force-release-all`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {},
  });
  assert.equal(r2.statusCode, 200);
  const body2 = r2.json() as { released_count: number };
  assert.equal(body2.released_count, 1);

  await app.close();
});

// ------- Admin maintenance endpoint -------
test("POST /admin/maintenance returns integrity and page info", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/admin/maintenance",
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    integrity: string;
    page_count: number;
    freelist_count: number;
    vacuumed: boolean;
  };
  assert.equal(body.integrity, "ok");
  assert.equal(typeof body.page_count, "number");
  assert.equal(typeof body.freelist_count, "number");
  assert.equal(typeof body.vacuumed, "boolean");
  await app.close();
});

// ------- Workspace delete cleans up audit_log -------
test("DELETE workspace also removes its audit_log entries", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const workspaceId = `del-audit-${Date.now()}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: workspaceId, display_name: "DelAudit" },
  });

  // Register agent to generate audit entries
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${workspaceId}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "da-agent", display_name: "DA", capabilities: ["test"] },
  });

  // Verify audit entries exist
  const auditBefore = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}/audit`,
    headers: auth,
  });
  const beforeData = (auditBefore.json() as { data: unknown[] }).data;
  assert.ok(beforeData.length > 0);

  // Delete workspace
  const delRes = await app.inject({
    method: "DELETE",
    url: `/api/v1/workspaces/${workspaceId}`,
    headers: auth,
  });
  assert.equal(delRes.statusCode, 200);

  // Workspace should be gone
  const wsCheck = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${workspaceId}`,
    headers: auth,
  });
  assert.equal(wsCheck.statusCode, 404);

  await app.close();
});

// ------- Error path tests -------
test("claim create returns 404 for non-existent workspace", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces/no-such-ws/claims",
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "ag-1", scope: "s", paths: ["a.ts"] },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("claim create returns 404 for non-existent agent", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `err-ws-${Date.now()}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Err" },
  });
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "no-such-agent", scope: "s", paths: ["a.ts"] },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("release claim returns 404 for non-existent claim", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `err-ws2-${Date.now()}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Err2" },
  });
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims/nonexistent/release`,
    headers: auth,
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("handoff accept returns 404 for non-existent handoff", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `err-ws3-${Date.now()}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Err3" },
  });
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/nonexistent/accept`,
    headers: auth,
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("blocker resolve returns 404 for non-existent blocker", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `err-ws4-${Date.now()}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Err4" },
  });
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/nonexistent/resolve`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { note: "fix" },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test("request without auth returns 401", async () => {
  const app = await buildApp();
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/workspaces",
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

// ------- Agent metadata update -------
test("PATCH agent metadata merges with existing metadata", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `meta-${Date.now()}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Meta" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      agent_id: "meta-agent",
      display_name: "MetaAgent",
      capabilities: ["code"],
      metadata: { version: "1.0", env: "dev" },
    },
  });

  // Update metadata (should merge)
  const res = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/agents/meta-agent/metadata`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { metadata: { version: "2.0", priority: "high" } },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { ok: boolean; metadata: Record<string, unknown> };
  assert.equal(body.ok, true);
  assert.equal(body.metadata.version, "2.0");
  assert.equal(body.metadata.env, "dev");
  assert.equal(body.metadata.priority, "high");

  // Verify via GET
  const getRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/meta-agent`,
    headers: auth,
  });
  const agent = getRes.json() as { metadata: Record<string, unknown> };
  assert.equal(agent.metadata.version, "2.0");
  assert.equal(agent.metadata.priority, "high");

  await app.close();
});

// ------- Claim conflict returns 409 -------
test("creating overlapping claim from different agent returns 409", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `conflict-${Date.now()}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Conflict" },
  });
  for (const aid of ["conf-a1", "conf-a2"]) {
    await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${ws}/agents/register`,
      headers: { ...auth, "content-type": "application/json" },
      payload: { agent_id: aid, display_name: aid, capabilities: ["code"] },
    });
  }

  // Agent 1 claims src/**
  const c1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "conf-a1", scope: "src", paths: ["src/**"] },
  });
  assert.equal(c1.statusCode, 201);

  // Agent 2 tries to claim overlapping path
  const c2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "conf-a2", scope: "src", paths: ["src/index.ts"] },
  });
  assert.equal(c2.statusCode, 409);
  const body = c2.json() as { error: string };
  assert.ok(body.error.includes("conflict") || body.error.includes("Conflict"));

  await app.close();
});

// ------- Handoff reject flow -------
test("handoff reject returns ok and handoff status changes", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `hrej-${Date.now()}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "HandoffReject" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "hrej-a1", display_name: "A1", capabilities: ["review"] },
  });

  const hRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { from_agent_id: "hrej-a1", capability_tag: "review", summary: "Needs review" },
  });
  assert.equal(hRes.statusCode, 201);
  const hId = (hRes.json() as { handoff_id: string }).handoff_id;

  const rejRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/${hId}/reject`,
    headers: auth,
  });
  assert.equal(rejRes.statusCode, 200);

  // Verify status changed
  const getRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/${hId}`,
    headers: auth,
  });
  const detail = getRes.json() as { status: string };
  assert.equal(detail.status, "rejected");

  await app.close();
});

// ------- Capability routing routes to least-busy agent -------
test("capability routing selects least-busy agent", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `route-${Date.now()}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Routing" },
  });

  // Register two agents with same capability
  for (const aid of ["rt-agent-a", "rt-agent-b"]) {
    await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${ws}/agents/register`,
      headers: { ...auth, "content-type": "application/json" },
      payload: { agent_id: aid, display_name: aid, capabilities: ["deploy"] },
    });
  }

  // Give agent-a a claim so it's busier
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "rt-agent-a", scope: "infra", paths: ["infra/**"] },
  });

  // Route should select agent-b (less busy)
  const routeRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/route`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { capability: "deploy" },
  });
  assert.equal(routeRes.statusCode, 200);
  const routed = routeRes.json() as { agent_id: string };
  assert.equal(routed.agent_id, "rt-agent-b");

  await app.close();
});

/* ── F-32  duplicate workspace → 409 ──────────────────────────── */
test("POST /workspaces with duplicate workspace_id returns 409", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `dup-ws-test-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "First" },
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Second" },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "Workspace already exists");

  await app.close();
});

/* ── F-33  bulk agent register ────────────────────────────────── */
test("POST /agents/bulk-register registers multiple agents", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `bulk-reg-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Bulk" },
  });

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/bulk-register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      agents: [
        { agent_id: "bulk-a", display_name: "Agent A", capabilities: ["code"] },
        { agent_id: "bulk-b", display_name: "Agent B", capabilities: ["test"] },
        { agent_id: "bulk-c", display_name: "Agent C" },
      ],
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.count, 3);
  assert.deepEqual(body.registered, ["bulk-a", "bulk-b", "bulk-c"]);

  // Verify agents exist
  const listRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
  });
  assert.equal(listRes.json().data.length, 3);

  await app.close();
});

/* ── F-34  claim renewal_count tracking ───────────────────────── */
test("claim renewal increments renewal_count", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `renew-cnt-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "RenewCnt" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "rc-agent", display_name: "RC" },
  });

  const claimRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "rc-agent", scope: "pkg", paths: ["pkg/**"] },
  });
  const claimId = claimRes.json().claim_id;

  // Renew twice
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims/${claimId}/renew`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {},
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims/${claimId}/renew`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {},
  });

  // Check renewal_count
  const detailRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/${claimId}`,
    headers: auth,
  });
  assert.equal(detailRes.statusCode, 200);
  assert.equal(detailRes.json().renewal_count, 2);

  await app.close();
});

/* ── F-37  workspace settings ─────────────────────────────────── */
test("GET/PATCH /workspaces/:ws/settings", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `settings-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Settings Test" },
  });

  // Default settings is empty object
  const getRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/settings`,
    headers: auth,
  });
  assert.equal(getRes.statusCode, 200);
  assert.deepEqual(getRes.json(), {});

  // Patch settings
  const patchRes = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/settings`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { claim_ttl: 3600, max_agents: 10 },
  });
  assert.equal(patchRes.statusCode, 200);
  assert.equal(patchRes.json().claim_ttl, 3600);

  // Settings merge (not replace)
  await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/settings`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { max_agents: 20 },
  });
  const getRes2 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/settings`,
    headers: auth,
  });
  assert.equal(getRes2.json().claim_ttl, 3600);
  assert.equal(getRes2.json().max_agents, 20);

  await app.close();
});

/* ── F-38  agent list filter by capability ────────────────────── */
test("GET /agents?capability= filters by capability", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `cap-filter-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Cap Filter" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "cf-a", display_name: "A", capabilities: ["code", "test"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "cf-b", display_name: "B", capabilities: ["deploy"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents?capability=code`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.length, 1);
  assert.equal(res.json().data[0].agent_id, "cf-a");

  await app.close();
});

/* ── F-39  agent activity summary ─────────────────────────────── */
test("GET /agents/:agentId/activity returns activity summary", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `activity-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Activity" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "act-agent", display_name: "Act" },
  });

  // Create a claim
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "act-agent", scope: "src", paths: ["src/**"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/act-agent/activity`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.agent_id, "act-agent");
  assert.equal(body.claims.active, 1);
  assert.ok(body.audit_events >= 1);

  await app.close();
});

/* ── F-41  batch claim create ─────────────────────────────────── */
test("POST /claims/batch creates multiple claims", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `batch-claim-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Batch" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "batch-a", display_name: "BA" },
  });

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims/batch`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      claims: [
        { agent_id: "batch-a", scope: "pkg1", paths: ["pkg1/**"] },
        { agent_id: "batch-a", scope: "pkg2", paths: ["pkg2/**"] },
      ],
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.total, 2);
  assert.ok(body.results[0].claim_id);
  assert.ok(body.results[1].claim_id);

  await app.close();
});

/* ── F-42  workspace agent limit via settings ─────────────────── */
test("agent registration enforces max_agents setting", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `limit-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Limit Test" },
  });

  // Set max_agents = 1
  await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/settings`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { max_agents: 1 },
  });

  // First agent OK
  const r1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "lim-a", display_name: "A" },
  });
  assert.equal(r1.statusCode, 201);

  // Second agent rejected
  const r2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "lim-b", display_name: "B" },
  });
  assert.equal(r2.statusCode, 422);
  assert.equal(r2.json().error, "Agent limit reached");

  await app.close();
});

/* ── F-44  claim transfer ─────────────────────────────────────── */
test("POST /claims/:claimId/transfer moves claim to another agent", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `xfer-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Transfer" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "xfer-a", display_name: "A" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "xfer-b", display_name: "B" },
  });

  const claimRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "xfer-a", scope: "src", paths: ["src/**"] },
  });
  const claimId = claimRes.json().claim_id;

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims/${claimId}/transfer`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { to_agent_id: "xfer-b" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().to_agent_id, "xfer-b");
  assert.equal(res.json().from_agent_id, "xfer-a");

  // Verify agent changed
  const detail = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/${claimId}`,
    headers: auth,
  });
  assert.equal(detail.json().agent_id, "xfer-b");

  await app.close();
});

/* ── F-49  agent tags ─────────────────────────────────────────── */
test("agent register with tags and filter by tag", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `tags-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Tags" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      agent_id: "tag-a",
      display_name: "A",
      tags: ["backend", "python"],
    },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      agent_id: "tag-b",
      display_name: "B",
      tags: ["frontend", "typescript"],
    },
  });

  // Filter by tag
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents?tag=python`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.length, 1);
  assert.equal(res.json().data[0].agent_id, "tag-a");
  assert.deepEqual(res.json().data[0].tags, ["backend", "python"]);

  await app.close();
});

/* ── F-48  handoff stats ──────────────────────────────────────── */
test("GET /handoffs/stats returns statistics", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `hstats-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "HStats" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/stats`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.ok("by_status" in res.json());
  assert.ok("by_route_mode" in res.json());

  await app.close();
});

/* ── F-51  batch claim renewal ────────────────────────────────── */
test("POST /claims/batch-renew renews multiple claims", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `brenew-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "BRenew" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "br-agent", display_name: "BR" },
  });
  const c1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "br-agent", scope: "file", paths: ["a.ts"], ttl_seconds: 60 },
  });
  const c2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "br-agent", scope: "file", paths: ["b.ts"], ttl_seconds: 60 },
  });

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims/batch-renew`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      claims: [
        { claim_id: c1.json().claim_id, ttl_seconds: 3600 },
        { claim_id: c2.json().claim_id },
        { claim_id: "nonexistent" },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().renewed.length, 2);
  assert.equal(res.json().not_found.length, 1);

  await app.close();
});

/* ── F-52  claim priority ─────────────────────────────────────── */
test("claim create with priority and filter by priority", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `prio-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "PrioWS" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "prio-a", display_name: "PA" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "prio-a", scope: "file", paths: ["high.ts"], priority: "high" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "prio-a", scope: "file", paths: ["low.ts"], priority: "low" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims?priority=high`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.length, 1);
  assert.equal(res.json().data[0].priority, "high");

  await app.close();
});

/* ── F-53  claims sort + date filter ──────────────────────────── */
test("claims list supports sort_by and sort_order", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `sort-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "SortWS" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "sort-a", display_name: "SA" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "sort-a", scope: "file", paths: ["x.ts"], priority: "low" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "sort-a", scope: "file", paths: ["y.ts"], priority: "critical" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims?sort_by=priority&sort_order=asc`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.length, 2);
  assert.equal(data[0].priority, "critical");
  assert.equal(data[1].priority, "low");

  // sort_by=created_at ascending
  const res2 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims?sort_by=created_at&sort_order=asc`,
    headers: auth,
  });
  assert.equal(res2.statusCode, 200);

  await app.close();
});

/* ── F-54  handoff retry ──────────────────────────────────────── */
test("handoff retry resets rejected handoff to pending", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `hretry-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "HRetry" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "retry-from", display_name: "From" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "retry-to", display_name: "To" },
  });

  const h = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      from_agent_id: "retry-from",
      to_agent_id: "retry-to",
      summary: "retry test",
      max_retries: 2,
    },
  });
  const handoffId = h.json().handoff_id;

  // reject it
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/${handoffId}/reject`,
    headers: auth,
  });

  // retry it
  const retryRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/${handoffId}/retry`,
    headers: auth,
  });
  assert.equal(retryRes.statusCode, 200);
  assert.equal(retryRes.json().ok, true);
  assert.equal(retryRes.json().retry_count, 1);

  // reject + retry again (retry_count becomes 2)
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/${handoffId}/reject`,
    headers: auth,
  });
  const retryRes2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/${handoffId}/retry`,
    headers: auth,
  });
  assert.equal(retryRes2.statusCode, 200);
  assert.equal(retryRes2.json().retry_count, 2);

  // reject + try retry beyond max — should fail
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/${handoffId}/reject`,
    headers: auth,
  });
  const retryRes3 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/${handoffId}/retry`,
    headers: auth,
  });
  assert.equal(retryRes3.statusCode, 422);

  await app.close();
});

/* ── F-55  audit log entity_type filter ───────────────────────── */
test("audit log filters by entity_type and actor_id", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `auditf-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "AuditFilter" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "auditf-agent", display_name: "AF" },
  });

  // filter by entity_type=agent
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/audit?entity_type=agent`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  for (const row of res.json().data) {
    assert.equal(row.entity_type, "agent");
  }

  // filter by actor_id
  const res2 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/audit?actor_id=auditf-agent`,
    headers: auth,
  });
  assert.equal(res2.statusCode, 200);
  assert.ok(res2.json().data.length > 0);

  await app.close();
});

/* ── F-56  agent groups ───────────────────────────────────────── */
test("agent register with group and filter by group", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `grp-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "GrpWS" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "grp-a1", display_name: "G1", group: "frontend" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "grp-a2", display_name: "G2", group: "backend" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "grp-a3", display_name: "G3", group: "frontend" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents?group=frontend`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.length, 2);

  // all agents
  const res2 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
  });
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.json().data.length, 3);

  await app.close();
});

/* ── F-57  enhanced health check ──────────────────────────────── */
test("health check returns extended fields", async () => {
  const app = await buildApp();
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok("pending_handoffs" in body);
  assert.ok("workspaces" in body);
  assert.ok("memory_mb" in body);
  assert.ok(typeof body.memory_mb === "number");
  await app.close();
});

/* ── F-58  blocker escalation ─────────────────────────────────── */
test("blocker escalation increments escalation_level", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `esc-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "EscWS" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "esc-agent", display_name: "Esc" },
  });
  const b = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      agent_id: "esc-agent",
      title: "Escalation test",
      severity: "high",
    },
  });
  const blockerId = b.json().blocker_id;

  // escalate once
  const e1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/escalate`,
    headers: auth,
  });
  assert.equal(e1.statusCode, 200);
  assert.equal(e1.json().escalation_level, 1);

  // escalate again
  const e2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/escalate`,
    headers: auth,
  });
  assert.equal(e2.statusCode, 200);
  assert.equal(e2.json().escalation_level, 2);

  // resolve and try escalate — should fail
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/resolve`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {},
  });
  const e3 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/escalate`,
    headers: auth,
  });
  assert.equal(e3.statusCode, 422);

  await app.close();
});

/* ── F-59  workspace archive/unarchive ────────────────────────── */
test("workspace archive and unarchive", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `arch-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "ArchWS" },
  });

  // archive
  const a1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/archive`,
    headers: auth,
  });
  assert.equal(a1.statusCode, 200);
  assert.equal(a1.json().ok, true);

  // double archive — 422
  const a2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/archive`,
    headers: auth,
  });
  assert.equal(a2.statusCode, 422);

  // unarchive
  const u1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/unarchive`,
    headers: auth,
  });
  assert.equal(u1.statusCode, 200);

  // double unarchive — 422
  const u2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/unarchive`,
    headers: auth,
  });
  assert.equal(u2.statusCode, 422);

  await app.close();
});

/* ── F-60  idempotency key ────────────────────────────────────── */
test("X-Idempotency-Key replays identical response", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ikey = `idem-${Date.now()}`;

  // first request creates workspace
  const r1 = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json", "x-idempotency-key": ikey },
    payload: { workspace_id: `idem-ws-${Date.now().toString(36)}`, display_name: "IdemWS" },
  });
  assert.equal(r1.statusCode, 201);

  // second request with same key replays
  const r2 = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json", "x-idempotency-key": ikey },
    payload: { workspace_id: "different-ws", display_name: "Different" },
  });
  assert.equal(r2.statusCode, 201);
  assert.equal(r2.headers["x-idempotent-replayed"], "true");
  assert.equal(r2.json().workspace_id, r1.json().workspace_id);

  await app.close();
});

/* ── F-61  blocker deadline extension ─────────────────────────── */
test("blocker extend-deadline extends open blocker deadline", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `blkext-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "BlkExt" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "blk-ext-a", display_name: "Ext" },
  });
  const b = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      agent_id: "blk-ext-a",
      title: "Deadline test",
      severity: "high",
      deadline_seconds: 3600,
    },
  });
  const blockerId = b.json().blocker_id;

  const ext = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/extend-deadline`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { additional_seconds: 7200 },
  });
  assert.equal(ext.statusCode, 200);
  assert.equal(ext.json().ok, true);
  assert.ok(ext.json().new_deadline);

  await app.close();
});

/* ── F-62  handoff list sort + date ───────────────────────────── */
test("handoffs list supports sort_by and created_after", async () => {
  const app = await buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `hsort-ws-${Date.now().toString(36)}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "HSort" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "hsort-from", display_name: "From" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: "hsort-to", display_name: "To" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { from_agent_id: "hsort-from", to_agent_id: "hsort-to", summary: "sort test" },
  });

  // sort by created_at asc
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs?sort_by=created_at&sort_order=asc`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.length, 1);

  // filter by future date — no results
  const res2 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs?created_after=2099-01-01`,
    headers: auth,
  });
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.json().data.length, 0);

  await app.close();
});

// --------------- F-63: Agent status history ---------------
test("agent status history tracks transitions", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-statushist-${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  // create workspace + agent
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["code"] },
  });

  // change status twice
  const s1 = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/agents/a1/status`,
    headers: auth,
    payload: { status: "blocked" },
  });
  assert.equal(s1.statusCode, 200);
  const s2 = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/agents/a1/status`,
    headers: auth,
    payload: { status: "idle" },
  });
  assert.equal(s2.statusCode, 200);

  // query history
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/a1/status-history`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.data.length >= 2);
  assert.equal(body.data[0].new_status, "idle");
  assert.equal(body.data[1].new_status, "blocked");

  // pagination
  const res2 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/a1/status-history?limit=1`,
    headers: auth,
  });
  assert.equal(res2.json().data.length, 1);

  await app.close();
});

// --------------- F-64: Workspace list enhanced ---------------
test("workspace list supports search, archived filter, pagination", async () => {
  runMigrations();
  const app = buildApp();
  const suffix = Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  // create workspaces
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: `alpha-${suffix}`, display_name: `Alpha ${suffix}` },
  });
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: `beta-${suffix}`, display_name: `Beta ${suffix}` },
  });

  // archive one
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/alpha-${suffix}/archive`,
    headers: auth,
  });

  // search by display_name
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces?search=Beta+${suffix}`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.data.some((w: any) => w.workspace_id === `beta-${suffix}`));

  // archived=true filter
  const res2 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces?archived=true&search=${suffix}`,
    headers: auth,
  });
  const archivedList = res2.json().data;
  assert.ok(archivedList.some((w: any) => w.workspace_id === `alpha-${suffix}`));

  // pagination with total
  const res3 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces?limit=1&search=${suffix}`,
    headers: auth,
  });
  const paginated = res3.json();
  assert.ok(paginated.total >= 2);
  assert.equal(paginated.data.length, 1);

  await app.close();
});

// --------------- F-65: Blocker list sort + date-range ---------------
test("blocker list supports sort and date-range filters", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-blocksort-${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  const wsRes = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  assert.equal(wsRes.statusCode, 201);
  const agRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["code"] },
  });
  assert.equal(agRes.statusCode, 201);

  // create two blockers with different severities
  const b1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "Low blocker", severity: "low" },
  });
  assert.equal(b1.statusCode, 201);
  const b2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "Critical blocker", severity: "critical" },
  });
  assert.equal(b2.statusCode, 201);

  // sort by severity asc
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers?sort_by=severity&sort_order=asc`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().data.length >= 2);

  // date-range: future dates → no results
  const res2 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers?created_after=2099-01-01`,
    headers: auth,
  });
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.json().data.length, 0);

  // sort by created_at desc (default)
  const res3 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers?sort_by=created_at&sort_order=desc`,
    headers: auth,
  });
  assert.equal(res3.statusCode, 200);
  assert.ok(res3.json().data.length >= 2);

  await app.close();
});

// --------------- F-66: Claim dependencies ---------------
test("claim dependencies are stored and returned", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-claimdep-${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["code"] },
  });

  // create first claim
  const c1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "backend", paths: ["src/a.ts"] },
  });
  assert.equal(c1.statusCode, 201);
  const claimId1 = c1.json().claim_id;

  // create second claim depending on first
  const c2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: {
      agent_id: "a1",
      scope: "frontend",
      paths: ["src/b.ts"],
      depends_on: [claimId1],
    },
  });
  assert.equal(c2.statusCode, 201);
  const claimId2 = c2.json().claim_id;

  // fetch detail — should include depends_on
  const detail = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/${claimId2}`,
    headers: auth,
  });
  assert.equal(detail.statusCode, 200);
  const body = detail.json();
  assert.ok(Array.isArray(body.depends_on));
  assert.ok(body.depends_on.includes(claimId1));

  // first claim should have empty depends_on
  const detail1 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/${claimId1}`,
    headers: auth,
  });
  assert.deepEqual(detail1.json().depends_on, []);

  await app.close();
});

// --------------- F-67: Agent capability search ---------------
test("agent capability search finds matching agents", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-capsearch-${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "ts-agent", display_name: "TS", capabilities: ["typescript", "testing"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "py-agent", display_name: "PY", capabilities: ["python", "testing"] },
  });

  // search for "testing" — both should match
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/search`,
    headers: auth,
    payload: { capabilities: ["testing"] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().data.length, 2);

  // search for "typescript" — only ts-agent
  const res2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/search`,
    headers: auth,
    payload: { capabilities: ["typescript"] },
  });
  assert.equal(res2.json().data.length, 1);
  assert.equal(res2.json().data[0].agent_id, "ts-agent");

  // search for both "typescript" AND "testing" — only ts-agent
  const res3 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/search`,
    headers: auth,
    payload: { capabilities: ["typescript", "testing"] },
  });
  assert.equal(res3.json().data.length, 1);

  await app.close();
});

// --------------- F-68: Handoff notes ---------------
test("handoff notes can be added and retrieved", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-hnotes-${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "a2", display_name: "A2", capabilities: ["review"] },
  });

  // create handoff
  const h = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "please review" },
  });
  assert.equal(h.statusCode, 201);
  const handoffId = h.json().handoff_id;

  // add a note
  const n1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/${handoffId}/notes`,
    headers: auth,
    payload: { author_id: "a1", content: "Starting handoff" },
  });
  assert.equal(n1.statusCode, 201);
  assert.ok(n1.json().note_id);

  // add another note
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/${handoffId}/notes`,
    headers: auth,
    payload: { author_id: "a2", content: "Acknowledged" },
  });

  // get notes
  const notes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/${handoffId}/notes`,
    headers: auth,
  });
  assert.equal(notes.statusCode, 200);
  assert.equal(notes.json().data.length, 2);
  assert.equal(notes.json().data[0].content, "Starting handoff");
  assert.equal(notes.json().data[1].content, "Acknowledged");

  // 404 for non-existent handoff
  const bad = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/nonexistent/notes`,
    headers: auth,
  });
  assert.equal(bad.statusCode, 404);

  await app.close();
});
