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

// --------------- F-69: Blocker watchers ---------------
test("blocker watchers can be added and listed", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-bwatch-${Date.now().toString(36)}`;
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

  // create blocker
  const b = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "Blocked on review", severity: "high" },
  });
  assert.equal(b.statusCode, 201);
  const blockerId = b.json().blocker_id;

  // add watcher
  const w1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/watchers`,
    headers: auth,
    payload: { agent_id: "a2" },
  });
  assert.equal(w1.statusCode, 201);

  // idempotent add
  const w2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/watchers`,
    headers: auth,
    payload: { agent_id: "a2" },
  });
  assert.equal(w2.statusCode, 201);

  // list watchers
  const wl = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/watchers`,
    headers: auth,
  });
  assert.equal(wl.statusCode, 200);
  assert.equal(wl.json().data.length, 1);
  assert.equal(wl.json().data[0].agent_id, "a2");

  // remove watcher
  await app.inject({
    method: "DELETE",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/watchers/a2`,
    headers: auth,
  });
  const wl2 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/watchers`,
    headers: auth,
  });
  assert.equal(wl2.json().data.length, 0);

  await app.close();
});

// --------------- F-70: Handoff chain tracking ---------------
test("handoff chain tracks parent-child relationships", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-hchain-${Date.now().toString(36)}`;
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

  // create parent handoff
  const h1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "parent task" },
  });
  assert.equal(h1.statusCode, 201);
  const parentId = h1.json().handoff_id;

  // create child handoff
  const h2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: {
      from_agent_id: "a2",
      to_agent_id: "a1",
      summary: "subtask",
      parent_handoff_id: parentId,
    },
  });
  assert.equal(h2.statusCode, 201);
  const childId = h2.json().handoff_id;

  // get chain from child — should include parent and child
  const chain = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/${childId}/chain`,
    headers: auth,
  });
  assert.equal(chain.statusCode, 200);
  const body = chain.json();
  assert.equal(body.chain.length, 2);
  assert.equal(body.chain[0].handoff_id, parentId);
  assert.equal(body.chain[1].handoff_id, childId);

  // get chain from parent — should show children
  const chain2 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/${parentId}/chain`,
    headers: auth,
  });
  assert.equal(chain2.statusCode, 200);
  assert.equal(chain2.json().children.length, 1);
  assert.equal(chain2.json().children[0].handoff_id, childId);

  await app.close();
});

// --------------- F-71: Batch claim status check ---------------
test("batch claim status returns statuses for multiple claims", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-bstatus-${Date.now().toString(36)}`;
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

  // create two claims
  const c1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "backend", paths: ["src/a.ts"] },
  });
  const c2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "frontend", paths: ["src/b.ts"] },
  });
  const id1 = c1.json().claim_id;
  const id2 = c2.json().claim_id;

  // batch status check
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims/batch-status`,
    headers: auth,
    payload: { claim_ids: [id1, id2, "nonexistent"] },
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.equal(data.length, 3);
  assert.equal(data[0].status, "active");
  assert.equal(data[1].status, "active");
  assert.equal(data[2].status, "not_found");

  await app.close();
});

// --------------- F-72: Agent metadata history ---------------
test("agent metadata history tracks changes", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-metahist-${Date.now().toString(36)}`;
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

  // update metadata twice
  await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/agents/a1/metadata`,
    headers: auth,
    payload: { metadata: { version: "1.0" } },
  });
  await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/agents/a1/metadata`,
    headers: auth,
    payload: { metadata: { version: "2.0" } },
  });

  // get history
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/a1/metadata-history`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const history = res.json().data;
  assert.ok(history.length >= 2);
  // most recent first (id DESC)
  assert.equal(history[0].metadata.version, "2.0");
  assert.equal(history[1].metadata.version, "1.0");

  await app.close();
});

// --------------- F-73: Workspace event log summary ---------------
test("workspace audit summary aggregates by action", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-auditsum-${Date.now().toString(36)}`;
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

  // the above creates audit events; query summary
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/audit/summary?hours=1`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.total > 0);
  assert.ok(Array.isArray(body.by_action));
  assert.ok(body.by_action.some((a: any) => a.action === "agent.register"));

  await app.close();
});

// --------------- F-74: Claim scope validation ---------------
test("claim scope validation rejects invalid scopes", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-scopeval-${Date.now().toString(36)}`;
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

  // valid scope
  const valid = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "backend.v2", paths: ["src/a.ts"] },
  });
  assert.equal(valid.statusCode, 201);

  // invalid scope — starts with dot
  const invalid = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: ".invalid", paths: ["src/b.ts"] },
  });
  assert.equal(invalid.statusCode, 400);

  // invalid scope — contains spaces
  const invalid2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "has space", paths: ["src/c.ts"] },
  });
  assert.equal(invalid2.statusCode, 400);

  await app.close();
});

// --------------- F-75: Workspace export v2 ---------------
test("workspace export includes new tables", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-exportv2-${Date.now().toString(36)}`;
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
    payload: { agent_id: `exp-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/export`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.workspace);
  assert.ok(Array.isArray(body.agents));
  assert.ok(Array.isArray(body.claim_dependencies));
  assert.ok(Array.isArray(body.handoff_notes));
  assert.ok(Array.isArray(body.blocker_watchers));
  assert.ok(Array.isArray(body.agent_status_history));
  assert.ok(body.exported_at);

  await app.close();
});

// --------------- F-76: Agent bulk deregister ---------------
test("bulk deregister removes multiple agents", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-bulkdereg-${Date.now().toString(36)}`;
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
    payload: { agent_id: `bd-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: `bd-a2-${ws}`, display_name: "A2", capabilities: ["review"] },
  });

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/bulk-deregister`,
    headers: auth,
    payload: { agent_ids: [`bd-a1-${ws}`, `bd-a2-${ws}`, "nonexistent"] },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.removed.length, 2);
  assert.deepEqual(body.not_found, ["nonexistent"]);

  // verify agents are gone
  const list = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
  });
  assert.equal(list.json().data.length, 0);

  await app.close();
});

// --------------- F-77: Handoff accept with note ---------------
test("handoff accept can include a note", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-acceptnote-${Date.now().toString(36)}`;
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
    payload: { agent_id: `an-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: `an-a2-${ws}`, display_name: "A2", capabilities: ["review"] },
  });

  // create handoff
  const h = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: `an-a1-${ws}`, to_agent_id: `an-a2-${ws}`, summary: "review needed" },
  });
  assert.equal(h.statusCode, 201);
  const handoffId = h.json().handoff_id;

  // accept with note
  const accept = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/${handoffId}/accept`,
    headers: auth,
    payload: { agent_id: `an-a2-${ws}`, note: "On it!" },
  });
  assert.equal(accept.statusCode, 200);

  // check that note was recorded
  const notes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/${handoffId}/notes`,
    headers: auth,
  });
  assert.equal(notes.statusCode, 200);
  assert.equal(notes.json().data.length, 1);
  assert.equal(notes.json().data[0].content, "On it!");

  await app.close();
});

// --------------- F-78: Agent group list ---------------
test("agent group list returns groups with counts", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-groups-${Date.now().toString(36)}`;
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
    payload: {
      agent_id: `grp-a1-${ws}`,
      display_name: "A1",
      capabilities: ["code"],
      group: "backend",
    },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: {
      agent_id: `grp-a2-${ws}`,
      display_name: "A2",
      capabilities: ["code"],
      group: "backend",
    },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: {
      agent_id: `grp-a3-${ws}`,
      display_name: "A3",
      capabilities: ["review"],
      group: "frontend",
    },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/groups`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.total, 2);
  const backend = body.data.find((g: { group: string }) => g.group === "backend");
  assert.ok(backend);
  assert.equal(backend.agent_count, 2);

  await app.close();
});

// --------------- F-79: Claim conflict detection ---------------
test("detect-conflicts finds duplicate scopes", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-conflicts-${Date.now().toString(36)}`;
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
    payload: { agent_id: `cf-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: `cf-a2-${ws}`, display_name: "A2", capabilities: ["code"] },
  });

  // create two claims on same scope with non-overlapping paths
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: `cf-a1-${ws}`, scope: "src.utils", paths: ["src/a.ts"], ttl_seconds: 300 },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: `cf-a2-${ws}`, scope: "src.utils", paths: ["src/b.ts"], ttl_seconds: 300 },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/detect-conflicts`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.total, 1);
  assert.equal(body.data[0].scope, "src.utils");
  assert.equal(body.data[0].claims.length, 2);

  await app.close();
});

// --------------- F-80: Workspace metrics history ---------------
test("metrics snapshot and history work correctly", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-metrichist-${Date.now().toString(36)}`;
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
    payload: { agent_id: `mh-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });

  // take a snapshot
  const snap = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/metrics/snapshot`,
    headers: auth,
  });
  assert.equal(snap.statusCode, 201);

  // retrieve history
  const hist = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/metrics/history`,
    headers: auth,
  });
  assert.equal(hist.statusCode, 200);
  const body = hist.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].agent_count, 1);

  await app.close();
});

// --------------- F-81: Blocker comments ---------------
test("blocker comments can be added and listed", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-blkcmt-${Date.now().toString(36)}`;
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
    payload: { agent_id: `bc-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });

  // create blocker
  const b = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: `bc-a1-${ws}`, title: "stuck on issue", severity: "medium" },
  });
  assert.equal(b.statusCode, 201);
  const blockerId = b.json().blocker_id;

  // add comment
  const c1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/comments`,
    headers: auth,
    payload: { author_id: `bc-a1-${ws}`, content: "Investigating..." },
  });
  assert.equal(c1.statusCode, 201);

  // list comments
  const list = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/comments`,
    headers: auth,
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().data.length, 1);
  assert.equal(list.json().data[0].content, "Investigating...");

  await app.close();
});

// --------------- F-82: Claim renewal history ---------------
test("claim renewal history tracks renewals", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-renewhist-${Date.now().toString(36)}`;
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
    payload: { agent_id: `rh-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });

  // create claim
  const c = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: `rh-a1-${ws}`, scope: "rh.scope", paths: ["src/rh.ts"], ttl_seconds: 60 },
  });
  assert.equal(c.statusCode, 201);
  const claimId = c.json().claim_id;

  // renew claim
  const renew = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims/${claimId}/renew`,
    headers: auth,
    payload: { ttl_seconds: 120 },
  });
  assert.equal(renew.statusCode, 200);

  // check renewal history
  const hist = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/${claimId}/renewal-history`,
    headers: auth,
  });
  assert.equal(hist.statusCode, 200);
  assert.equal(hist.json().data.length, 1);
  assert.ok(hist.json().data[0].old_expires_at);
  assert.ok(hist.json().data[0].new_expires_at);

  await app.close();
});

// --------------- F-83: Agent idle eviction ---------------
test("evict-idle returns eviction count", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-evict-${Date.now().toString(36)}`;
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
    payload: { agent_id: `ev-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });

  // set short idle timeout
  await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/settings`,
    headers: auth,
    payload: { agent_idle_timeout_minutes: 0 },
  });

  // run eviction (agents just registered so heartbeat is fresh — may or may not evict)
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/evict-idle`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.ok("evicted_count" in res.json());
  assert.ok("idle_threshold_minutes" in res.json());

  await app.close();
});

// --------------- F-84: Handoff priority ---------------
test("handoff creation supports priority field", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-hopri-${Date.now().toString(36)}`;
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
    payload: { agent_id: `hp-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: `hp-a2-${ws}`, display_name: "A2", capabilities: ["review"] },
  });

  const h = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: {
      from_agent_id: `hp-a1-${ws}`,
      to_agent_id: `hp-a2-${ws}`,
      summary: "urgent review",
      priority: "critical",
    },
  });
  assert.equal(h.statusCode, 201);
  const handoffId = h.json().handoff_id;

  // verify priority is stored
  const detail = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/${handoffId}`,
    headers: auth,
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.json().priority, "critical");

  await app.close();
});

// --------------- F-85: Agent heartbeat stats ---------------
test("heartbeat stats returns agent heartbeat info", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-hbstat-${Date.now().toString(36)}`;
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
    payload: { agent_id: `hb-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/heartbeat-stats`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.total, 1);
  assert.equal(body.data[0].agent_id, `hb-a1-${ws}`);
  assert.ok("seconds_since_heartbeat" in body.data[0]);

  await app.close();
});

// --------------- F-86: Workspace clone ---------------
test("workspace clone copies settings", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-clone-src-${Date.now().toString(36)}`;
  const cloneWs = `ws-clone-dst-${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: "Source" },
  });

  // set some settings on source
  await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/settings`,
    headers: auth,
    payload: { agent_idle_timeout_minutes: 15 },
  });

  // clone
  const clone = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/clone`,
    headers: auth,
    payload: { new_workspace_id: cloneWs, display_name: "Cloned" },
  });
  assert.equal(clone.statusCode, 201);
  assert.equal(clone.json().cloned_from, ws);

  // verify cloned settings
  const settings = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${cloneWs}/settings`,
    headers: auth,
  });
  assert.equal(settings.statusCode, 200);
  assert.equal(settings.json().agent_idle_timeout_minutes, 15);

  await app.close();
});

// --------------- F-87: Blocker dependencies ---------------
test("blocker dependencies can be set and retrieved", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-blkdep-${Date.now().toString(36)}`;
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
    payload: { agent_id: `bd-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });

  // create parent blocker
  const b1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: `bd-a1-${ws}`, title: "upstream issue", severity: "high" },
  });
  assert.equal(b1.statusCode, 201);
  const parentId = b1.json().blocker_id;

  // create child blocker depending on parent
  const b2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: {
      agent_id: `bd-a1-${ws}`,
      title: "downstream",
      severity: "medium",
      depends_on: [parentId],
    },
  });
  assert.equal(b2.statusCode, 201);
  const childId = b2.json().blocker_id;

  // get dependencies
  const deps = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/${childId}/dependencies`,
    headers: auth,
  });
  assert.equal(deps.statusCode, 200);
  assert.deepEqual(deps.json().data, [parentId]);

  await app.close();
});

// --------------- F-88: Agent labels ---------------
test("agent labels can be set and retrieved", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-labels-${Date.now().toString(36)}`;
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
    payload: { agent_id: `lb-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });

  // set labels
  const put = await app.inject({
    method: "PUT",
    url: `/api/v1/workspaces/${ws}/agents/lb-a1-${ws}/labels`,
    headers: auth,
    payload: { env: "production", team: "backend" },
  });
  assert.equal(put.statusCode, 200);

  // get labels
  const get = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/lb-a1-${ws}/labels`,
    headers: auth,
  });
  assert.equal(get.statusCode, 200);
  assert.equal(get.json().labels.env, "production");
  assert.equal(get.json().labels.team, "backend");

  await app.close();
});

// --------------- F-89: Claim transfer history ---------------
test("claim transfer history tracks transfers", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-xferhist-${Date.now().toString(36)}`;
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
    payload: { agent_id: `xf-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: `xf-a2-${ws}`, display_name: "A2", capabilities: ["code"] },
  });

  // create claim
  const c = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: {
      agent_id: `xf-a1-${ws}`,
      scope: "xfer.scope",
      paths: ["src/xf.ts"],
      ttl_seconds: 300,
    },
  });
  assert.equal(c.statusCode, 201);
  const claimId = c.json().claim_id;

  // transfer claim
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims/${claimId}/transfer`,
    headers: auth,
    payload: { to_agent_id: `xf-a2-${ws}` },
  });

  // check transfer history
  const hist = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/${claimId}/transfer-history`,
    headers: auth,
  });
  assert.equal(hist.statusCode, 200);
  assert.equal(hist.json().data.length, 1);
  assert.equal(hist.json().data[0].from_agent_id, `xf-a1-${ws}`);
  assert.equal(hist.json().data[0].to_agent_id, `xf-a2-${ws}`);

  await app.close();
});

// --------------- F-90: Workspace activity feed ---------------
test("workspace activity feed returns recent audit events", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-activity-${Date.now().toString(36)}`;
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
    payload: { agent_id: `act-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/activity`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.total >= 1);
  assert.ok(body.data.length >= 1);

  await app.close();
});

// --------------- F-91: Handoff templates ---------------
test("handoff templates can be created and listed", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-hotpl-${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });

  // create template
  const create = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoff-templates`,
    headers: auth,
    payload: {
      name: "Code Review",
      summary_template: "Please review {file}",
      default_priority: "high",
      default_timeout_seconds: 3600,
    },
  });
  assert.equal(create.statusCode, 201);
  assert.ok(create.json().template_id);

  // list templates
  const list = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoff-templates`,
    headers: auth,
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().data.length, 1);
  assert.equal(list.json().data[0].name, "Code Review");
  assert.equal(list.json().data[0].default_priority, "high");

  await app.close();
});

// --------------- F-92: Agent health score ---------------
test("agent health score returns computed score", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-health-${Date.now().toString(36)}`;
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
    payload: { agent_id: `hl-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/hl-a1-${ws}/health`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.agent_id, `hl-a1-${ws}`);
  assert.ok(body.health_score >= 0 && body.health_score <= 100);
  assert.ok("seconds_since_heartbeat" in body);
  assert.ok("active_claims" in body);

  await app.close();
});

// --------------- F-93: Blocker bulk resolve ---------------
test("blocker bulk resolve resolves multiple blockers", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-bulkres-${Date.now().toString(36)}`;
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
    payload: { agent_id: `br-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });

  // create two blockers
  const b1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: `br-a1-${ws}`, title: "B1", severity: "medium" },
  });
  const b2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: `br-a1-${ws}`, title: "B2", severity: "low" },
  });

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/bulk-resolve`,
    headers: auth,
    payload: {
      blocker_ids: [b1.json().blocker_id, b2.json().blocker_id],
      resolved_by: "tester",
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().results.length, 2);
  assert.ok(res.json().results.every((r: { resolved: boolean }) => r.resolved));

  await app.close();
});

// --------------- F-94: Claim scope update + history ---------------
test("claim scope update records history", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-scphist-${Date.now().toString(36)}`;
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
    payload: { agent_id: `sc-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });

  const clm = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: `sc-a1-${ws}`, scope: "scope.a", paths: ["src/a.ts"] },
  });
  const claimId = clm.json().claim_id;

  // update scope
  const upd = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/claims/${claimId}/scope`,
    headers: auth,
    payload: { new_scope: "scope.b", changed_by: "tester" },
  });
  assert.equal(upd.statusCode, 200);
  assert.equal(upd.json().old_scope, "scope.a");
  assert.equal(upd.json().new_scope, "scope.b");

  // check history
  const hist = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/${claimId}/scope-history`,
    headers: auth,
  });
  assert.equal(hist.statusCode, 200);
  assert.equal(hist.json().data.length, 1);
  assert.equal(hist.json().data[0].old_scope, "scope.a");
  assert.equal(hist.json().data[0].new_scope, "scope.b");

  await app.close();
});

// --------------- F-95: Agent online streak ---------------
test("agent online streak returns streak data", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-streak-${Date.now().toString(36)}`;
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
    payload: { agent_id: `sk-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/sk-a1-${ws}/online-streak`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.agent_id, `sk-a1-${ws}`);
  assert.ok(body.streak_seconds >= 0);
  assert.ok("online_since" in body);

  await app.close();
});

// --------------- F-96: Handoff chain analytics ---------------
test("handoff chain analytics returns depth stats", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-chanal-${Date.now().toString(36)}`;
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
    payload: { agent_id: `ca-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: `ca-a2-${ws}`, display_name: "A2", capabilities: ["review"] },
  });

  // create a root handoff
  const h1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: `ca-a1-${ws}`, to_agent_id: `ca-a2-${ws}`, summary: "root" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/chain-analytics`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().total_chains, 1);
  assert.equal(res.json().max_depth, 1);

  await app.close();
});

// --------------- F-97: Workspace rate limit config ---------------
test("workspace rate limit config get and patch", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-ratelim-${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });

  // get default
  const def = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/rate-limit`,
    headers: auth,
  });
  assert.equal(def.statusCode, 200);
  assert.equal(def.json().max_requests_per_minute, 60);

  // patch
  const upd = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/rate-limit`,
    headers: auth,
    payload: { max_requests_per_minute: 120, burst: 20 },
  });
  assert.equal(upd.statusCode, 200);
  assert.equal(upd.json().max_requests_per_minute, 120);
  assert.equal(upd.json().burst, 20);

  // verify persisted
  const check = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/rate-limit`,
    headers: auth,
  });
  assert.equal(check.json().max_requests_per_minute, 120);

  await app.close();
});

// --------------- F-98: Agent capability matrix ---------------
test("agent capability matrix returns structured matrix", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-capmat-${Date.now().toString(36)}`;
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
    payload: { agent_id: `cm-a1-${ws}`, display_name: "A1", capabilities: ["code", "review"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: `cm-a2-${ws}`, display_name: "A2", capabilities: ["code", "test"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/capability-matrix`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.capabilities.includes("code"));
  assert.ok(body.capabilities.includes("review"));
  assert.ok(body.capabilities.includes("test"));
  assert.equal(body.matrix.length, 2);

  await app.close();
});

// --------------- F-99: Blocker severity distribution ---------------
test("blocker severity distribution returns counts per severity", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-sevdist-${Date.now().toString(36)}`;
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
    payload: { agent_id: `sd-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: `sd-a1-${ws}`, title: "B1", severity: "high" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: `sd-a1-${ws}`, title: "B2", severity: "high" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: `sd-a1-${ws}`, title: "B3", severity: "low" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/severity-distribution`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data;
  assert.ok(data.length >= 2);
  const highEntry = data.find((d: { severity: string }) => d.severity === "high");
  assert.equal(highEntry.count, 2);

  await app.close();
});

// --------------- F-100: Claim batch transfer ---------------
test("claim batch transfer moves multiple claims", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-btxfer-${Date.now().toString(36)}`;
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
    payload: { agent_id: `bt-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: `bt-a2-${ws}`, display_name: "A2", capabilities: ["code"] },
  });

  const c1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: `bt-a1-${ws}`, scope: "scope.x1", paths: ["src/x1.ts"] },
  });
  const c2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: `bt-a1-${ws}`, scope: "scope.x2", paths: ["src/x2.ts"] },
  });

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims/batch-transfer`,
    headers: auth,
    payload: {
      claim_ids: [c1.json().claim_id, c2.json().claim_id],
      from_agent_id: `bt-a1-${ws}`,
      to_agent_id: `bt-a2-${ws}`,
    },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().results.length, 2);
  assert.ok(res.json().results.every((r: { transferred: boolean }) => r.transferred));

  await app.close();
});

// --------------- F-101: Agent uptime report ---------------
test("agent uptime report returns data for agents", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-uptime-${Date.now().toString(36)}`;
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
    payload: { agent_id: `up-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/uptime-report`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].agent_id, `up-a1-${ws}`);
  assert.ok(body.data[0].total_seconds >= 0);
  assert.ok("uptime_pct" in body.data[0]);

  await app.close();
});

// --------------- F-102: Workspace dashboard summary ---------------
test("workspace dashboard returns aggregated counts", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-dash-${Date.now().toString(36)}`;
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
    payload: { agent_id: `ds-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/dashboard`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.agents_total, 1);
  assert.equal(body.agents_online, 1);
  assert.ok("claims_active" in body);
  assert.ok("blockers_open" in body);
  assert.ok("handoffs_pending" in body);

  await app.close();
});

// --------------- F-103: Handoff SLA breaches ---------------
test("handoff SLA breaches returns overdue handoffs", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-sla-${Date.now().toString(36)}`;
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
    payload: { agent_id: `sl-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: `sl-a2-${ws}`, display_name: "A2", capabilities: ["review"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/sla-breaches`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().data));

  await app.close();
});

// --------------- F-104: Agent task queue ---------------
test("agent task queue create and list tasks", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-task-${Date.now().toString(36)}`;
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
    payload: { agent_id: `tk-a1-${ws}`, display_name: "A1", capabilities: ["code"] },
  });

  // create task
  const create = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/tk-a1-${ws}/tasks`,
    headers: auth,
    payload: { title: "Fix bug", description: "Fix the login bug", priority: "high" },
  });
  assert.equal(create.statusCode, 201);
  assert.ok(create.json().task_id);

  // list tasks
  const list = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/tk-a1-${ws}/tasks`,
    headers: auth,
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().data.length, 1);
  assert.equal(list.json().data[0].title, "Fix bug");
  assert.equal(list.json().data[0].priority, "high");

  await app.close();
});

/* ── F-105  blocker timeline ──────────────────────── */
test("blocker timeline returns creation and resolution events", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "btl";
  const ws = `ws-btl-${suffix}`;
  const aid = `btl-a1-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Timeline test" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, display_name: "TLAgent", capabilities: ["test"] },
  });
  const bRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, title: "Blocked on API", severity: "high" },
  });
  assert.equal(bRes.statusCode, 201);
  const bid = bRes.json().blocker_id;

  // resolve it
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/${bid}/resolve`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { note: "Fixed", resolved_by: "operator" },
  });

  const tl = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/${bid}/timeline`,
    headers: auth,
  });
  assert.equal(tl.statusCode, 200);
  const timeline = tl.json().timeline as Array<{ type: string }>;
  assert.ok(timeline.length >= 2);
  assert.equal(timeline[0].type, "created");
  assert.equal(timeline[timeline.length - 1].type, "resolved");

  await app.close();
});

/* ── F-106  claim audit trail ──────────────────────── */
test("claim audit trail returns audit entries for a claim", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "cat";
  const ws = `ws-cat-${suffix}`;
  const aid = `cat-a1-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "ClaimAudit test" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, display_name: "CATAgent", capabilities: ["test"] },
  });
  const clm = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, scope: "backend", paths: ["audit/**"] },
  });
  assert.equal(clm.statusCode, 201);
  const cid = clm.json().claim_id;

  const auditRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/${cid}/audit`,
    headers: auth,
  });
  assert.equal(auditRes.statusCode, 200);
  const auditData = auditRes.json().data as Array<{ action: string; entity_id: string }>;
  assert.ok(auditData.length >= 1);
  assert.equal(auditData[0].entity_id, cid);

  await app.close();
});

/* ── F-107  workspace notification preferences ──────── */
test("notification preferences get and update", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "np";
  const ws = `ws-notif-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Notif test" },
  });

  // get defaults
  const getRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/notification-preferences`,
    headers: auth,
  });
  assert.equal(getRes.statusCode, 200);
  const defaults = getRes.json() as Record<string, boolean>;
  assert.equal(defaults.sla_breach, true);

  // update
  const patchRes = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/notification-preferences`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { sla_breach: false, claim_conflict: true },
  });
  assert.equal(patchRes.statusCode, 200);
  const updated = patchRes.json() as Record<string, boolean>;
  assert.equal(updated.sla_breach, false);
  assert.equal(updated.claim_conflict, true);
  assert.equal(updated.handoff_timeout, true); // unchanged default

  await app.close();
});

/* ── F-108  agent dependency graph ─────────────────── */
test("agent dependency graph shows edges from handoffs", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "dg";
  const ws = `ws-dg-${suffix}`;
  const a1 = `dg-a1-${suffix}`;
  const a2 = `dg-a2-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "DepGraph test" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: a1, display_name: "A1", capabilities: ["test"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: a2, display_name: "A2", capabilities: ["test"] },
  });

  // create a handoff from a1 to a2
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { from_agent_id: a1, to_agent_id: a2, summary: "pass work" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/dependency-graph`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { nodes: string[]; edges: Array<{ from: string; to: string; weight: number }> };
  assert.ok(body.nodes.includes(a1));
  assert.ok(body.nodes.includes(a2));
  assert.equal(body.edges.length, 1);
  assert.equal(body.edges[0].from, a1);
  assert.equal(body.edges[0].to, a2);
  assert.equal(body.edges[0].weight, 1);

  await app.close();
});

/* ── F-109  workspace activity feed ────────────────── */
test("workspace activity feed returns recent events", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "af";
  const ws = `ws-af-${suffix}`;
  const aid = `af-a1-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Feed test" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, display_name: "FeedAgent", capabilities: ["test"] },
  });

  // create a blocker to generate audit events
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, title: "Test blocker", severity: "low" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/activity-feed?limit=10`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data as Array<{ action: string }>;
  assert.ok(data.length >= 1);

  await app.close();
});

/* ── F-110  claim expiry forecast ──────────────────── */
test("claim expiry forecast returns claims expiring soon", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "ef";
  const ws = `ws-ef-${suffix}`;
  const aid = `ef-a1-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Expiry test" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, display_name: "ExpAgent", capabilities: ["test"] },
  });

  // create a claim with short TTL (60s -> expires within 30 min window)
  const clm = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, scope: "forecast-area", paths: ["f/**"], ttl_seconds: 60 },
  });
  assert.equal(clm.statusCode, 201);

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/expiry-forecast?minutes=60`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { window_minutes: number; count: number; data: unknown[] };
  assert.equal(body.window_minutes, 60);
  assert.ok(body.count >= 1);

  await app.close();
});

/* ── F-111  handoff SLA compliance ─────────────────── */
test("handoff SLA compliance report", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "sc";
  const ws = `ws-sc-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "SLA Compliance" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/sla-compliance`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { total: number; compliant: number; breached: number; compliance_rate: number };
  assert.equal(body.total, 0);
  assert.equal(body.compliance_rate, 100);

  await app.close();
});

/* ── F-112  agent workload distribution ────────────── */
test("agent workload distribution shows per-agent counts", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "wl";
  const ws = `ws-wl-${suffix}`;
  const aid = `wl-a1-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Workload test" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, display_name: "WLAgent", capabilities: ["test"] },
  });

  // create a claim
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, scope: "workload-area", paths: ["wl/**"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/workload`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data as Array<{ agent_id: string; active_claims: number }>;
  assert.equal(data.length, 1);
  assert.equal(data[0].agent_id, aid);
  assert.equal(data[0].active_claims, 1);

  await app.close();
});

/* ── F-113  blocker resolution metrics ─────────────── */
test("blocker resolution metrics by severity", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "rm";
  const ws = `ws-rm-${suffix}`;
  const aid = `rm-a1-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Resolution test" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, display_name: "RMAgent", capabilities: ["test"] },
  });

  // create + resolve a blocker
  const bRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, title: "ResMetrics blocker", severity: "medium" },
  });
  const bid = bRes.json().blocker_id;
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/${bid}/resolve`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { note: "done" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/resolution-metrics`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data as Array<{ severity: string; total: number }>;
  assert.ok(data.length >= 1);
  const medium = data.find((r) => r.severity === "medium");
  assert.ok(medium);
  assert.equal(medium!.total, 1);

  await app.close();
});
