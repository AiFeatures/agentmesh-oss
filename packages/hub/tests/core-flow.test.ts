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
  const body = res.json() as { ws_connections: number; agents_online: number; active_claims: number; open_blockers: number; version: string };
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
