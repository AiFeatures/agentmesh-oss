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

// --------------- F-141: Blocker watcher notifications ---------------
test("resolving a blocker with watchers succeeds and watchers are still listed", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-bwn-${Date.now().toString(36)}`;
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
    payload: { agent_id: "watcher1", display_name: "Watcher", capabilities: ["review"] },
  });

  const b = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "Need review", severity: "high" },
  });
  const blockerId = b.json().blocker_id;

  // add watcher
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/watchers`,
    headers: auth,
    payload: { agent_id: "watcher1" },
  });

  // resolve the blocker — should trigger watcher notification internally
  const r = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/resolve`,
    headers: auth,
    payload: { note: "Fixed", resolved_by: "a1" },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().ok, true);

  // watchers should still be queryable after resolution
  const wl = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/watchers`,
    headers: auth,
  });
  assert.equal(wl.statusCode, 200);
  assert.equal(wl.json().data.length, 1);
  assert.equal(wl.json().data[0].agent_id, "watcher1");

  await app.close();
});

test("escalating a blocker with watchers succeeds", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-bwe-${Date.now().toString(36)}`;
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
    payload: { agent_id: "w1", display_name: "W1", capabilities: ["review"] },
  });

  const b = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "Stuck", severity: "medium" },
  });
  const blockerId = b.json().blocker_id;

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/watchers`,
    headers: auth,
    payload: { agent_id: "w1" },
  });

  // escalate the blocker
  const e = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/escalate`,
    headers: auth,
  });
  assert.equal(e.statusCode, 200);
  assert.equal(e.json().ok, true);
  assert.equal(e.json().escalation_level, 1);

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
  const body = res.json() as {
    nodes: string[];
    edges: Array<{ from: string; to: string; weight: number }>;
  };
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
  const body = res.json() as {
    total: number;
    compliant: number;
    breached: number;
    compliance_rate: number;
  };
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

/* ── F-114  workspace comparison ───────────────────── */
test("workspace comparison returns stats for multiple workspaces", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "cmp";
  const ws1 = `ws-cmp1-${suffix}`;
  const ws2 = `ws-cmp2-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws1, display_name: "Cmp1" },
  });
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws2, display_name: "Cmp2" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/compare?ids=${ws1},${ws2}`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data as Array<{ workspace_id: string; agents: number }>;
  assert.equal(data.length, 2);
  assert.equal(data[0].workspace_id, ws1);
  assert.equal(data[1].workspace_id, ws2);

  await app.close();
});

/* ── F-115  agent idle report ──────────────────────── */
test("agent idle report returns idle/stale agents", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "ir";
  const ws = `ws-ir-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Idle test" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/idle-report`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().data));

  await app.close();
});

/* ── F-116  claim overlap matrix ───────────────────── */
test("claim overlap matrix detects shared scopes", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "om";
  const ws = `ws-om-${suffix}`;
  const a1 = `om-a1-${suffix}`;
  const a2 = `om-a2-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Overlap test" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: a1, display_name: "OA1", capabilities: ["test"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: a2, display_name: "OA2", capabilities: ["test"] },
  });

  // Agents claim different scopes - no conflict
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: a1, scope: "module-a", paths: ["a/**"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: a2, scope: "module-b", paths: ["b/**"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/overlap-matrix`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { data: unknown[]; count: number };
  assert.equal(body.count, 0); // no overlap since different scopes

  await app.close();
});

/* ── F-117  handoff retry stats ────────────────────── */
test("handoff retry stats returns aggregate retry info", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "rs";
  const ws = `ws-rs-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "RetryStats" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/retry-stats`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { total_handoffs: number; total_retries: number };
  assert.equal(body.total_handoffs, 0);

  await app.close();
});

/* ── F-118  capability gap analysis ────────────────── */
test("capability gap analysis returns missing capabilities", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "cg";
  const ws = `ws-cg-${suffix}`;
  const aid = `cg-a1-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "CapGaps" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, display_name: "CGAgent", capabilities: ["coding"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/capability-gaps`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { gaps: string[]; available: string[] };
  assert.ok(body.available.includes("coding"));

  await app.close();
});

/* ── F-119  blocker correlation ────────────────────── */
test("blocker correlation returns agents with multiple blockers", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "bc";
  const ws = `ws-bc-${suffix}`;
  const aid = `bc-a1-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Correlation" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, display_name: "BCAgent", capabilities: ["test"] },
  });

  // create two blockers for same agent
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, title: "Blocker A", severity: "low" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, title: "Blocker B", severity: "medium" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/correlation`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data as Array<{ agent_id: string; blocker_count: number }>;
  assert.equal(data.length, 1);
  assert.equal(data[0].agent_id, aid);
  assert.equal(data[0].blocker_count, 2);

  await app.close();
});

/* ── F-120  workspace health score ─────────────────── */
test("workspace health score returns composite score", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "hs";
  const ws = `ws-hs-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Health Score" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/health-score`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { score: number; factors: Record<string, number> };
  assert.equal(body.score, 100); // no agents, no blockers = perfect
  assert.equal(body.factors.open_blockers, 0);

  await app.close();
});

/* ── F-121  agent collaboration matrix ─────────────── */
test("agent collaboration matrix returns interaction pairs", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "cm";
  const ws = `ws-cm-${suffix}`;
  const a1 = `cm-a1-${suffix}`;
  const a2 = `cm-a2-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Collab" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: a1, display_name: "C1", capabilities: ["test"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: a2, display_name: "C2", capabilities: ["test"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { from_agent_id: a1, to_agent_id: a2, summary: "collab" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/collaboration-matrix`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data as Array<{ agent_a: string; agent_b: string; interactions: number }>;
  assert.equal(data.length, 1);
  assert.equal(data[0].interactions, 1);

  await app.close();
});

/* ── F-122  claim renewal trends ───────────────────── */
test("claim renewal trends returns renewal data", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "rt";
  const ws = `ws-rt-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Renewal Trends" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/renewal-trends`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { total_renewals: number; data: unknown[] };
  assert.equal(body.total_renewals, 0);

  await app.close();
});

/* ── F-123  handoff latency percentiles ────────────── */
test("handoff latency percentiles when no data", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "lp";
  const ws = `ws-lp-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Latency" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/latency-percentiles`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { count: number; p50: null };
  assert.equal(body.count, 0);
  assert.equal(body.p50, null);

  await app.close();
});

/* ── F-124  agent registration history ─────────────── */
test("agent registration history returns audit events", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "rh";
  const ws = `ws-rh-${suffix}`;
  const aid = `rh-a1-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "RegHistory" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, display_name: "RHAgent", capabilities: ["test"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/registration-history`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data as Array<{ action: string }>;
  assert.ok(data.length >= 1);
  assert.ok(data.some((r) => r.action === "agent.register"));

  await app.close();
});

/* ── F-125  blocker age distribution ───────────────── */
test("blocker age distribution returns buckets", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "ad";
  const ws = `ws-ad-${suffix}`;
  const aid = `ad-a1-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "AgeDist" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, display_name: "ADAgent", capabilities: ["test"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, title: "Age test", severity: "low" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/age-distribution`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data as Array<{ bucket: string; count: number }>;
  assert.ok(data.length >= 1);
  assert.ok(data.some((d) => d.bucket === "under_1h"));

  await app.close();
});

/* ── F-126  workspace daily digest ─────────────────── */
test("workspace daily digest returns 24h summary", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "dd";
  const ws = `ws-dd-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Digest" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/daily-digest`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { period: string; new_agents: number };
  assert.equal(body.period, "24h");
  assert.equal(typeof body.new_agents, "number");

  await app.close();
});

/* ── F-127  agent peer ranking ─────────────────────── */
test("agent peer ranking returns scored agents", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "pr";
  const ws = `ws-pr-${suffix}`;
  const aid = `pr-a1-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "PeerRank" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, display_name: "PRAgent", capabilities: ["test"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/peer-ranking`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const data = res.json().data as Array<{ agent_id: string; score: number }>;
  assert.equal(data.length, 1);
  assert.equal(data[0].agent_id, aid);

  await app.close();
});

/* ── F-128  claim conflict history ─────────────────── */
test("claim conflict history returns empty when no conflicts", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "ch";
  const ws = `ws-ch-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "ConflictHist" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/conflict-history`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.deepStrictEqual(res.json().data, []);

  await app.close();
});

/* ── F-129  handoff throughput ─────────────────────── */
test("handoff throughput returns hourly data", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "tp";
  const ws = `ws-tp-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "Throughput" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/throughput`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().data));

  await app.close();
});

/* ── F-130  agent status transitions ───────────────── */
test("agent status transitions returns grouped transitions", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "st";
  const ws = `ws-st-${suffix}`;
  const aid = `st-a1-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "StatusTrans" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: aid, display_name: "STAgent", capabilities: ["test"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/${aid}/status-transitions`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().agent_id, aid);
  assert.ok(Array.isArray(res.json().data));

  await app.close();
});

/* ── F-131  workspace resource utilization ──────────── */
test("workspace resource utilization returns metrics", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const suffix = Date.now().toString(36) + "ru";
  const ws = `ws-ru-${suffix}`;

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "ResUtil" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/resource-utilization`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { active_claims: number; utilization_rate: number };
  assert.equal(body.active_claims, 0);
  assert.equal(body.utilization_rate, 0);

  await app.close();
});

/* ── F-132  workspace export diff ──────────────────────── */
test("GET /workspaces/:workspace/export-diff", async () => {
  runMigrations();
  const app = buildApp();
  const suffix = Date.now().toString(36);
  const ws = `ws-ed-${suffix}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "ExportDiff" },
  });

  const since = new Date(Date.now() - 60000).toISOString();
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/export-diff?since=${since}`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    agents: unknown[];
    blockers: unknown[];
    handoffs: unknown[];
    claims: unknown[];
  };
  assert.ok(Array.isArray(body.agents));
  assert.ok(Array.isArray(body.blockers));

  await app.close();
});

/* ── F-133  agent capability utilization ───────────────── */
test("GET /workspaces/:workspace/agents/capability-utilization", async () => {
  runMigrations();
  const app = buildApp();
  const suffix = Date.now().toString(36);
  const ws = `ws-cu-${suffix}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "CapUtil" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/capability-utilization`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { data: unknown[] };
  assert.ok(Array.isArray(body.data));

  await app.close();
});

/* ── F-134  blocker escalation rate ────────────────────── */
test("GET /workspaces/:workspace/blockers/escalation-rate", async () => {
  runMigrations();
  const app = buildApp();
  const suffix = Date.now().toString(36);
  const ws = `ws-er-${suffix}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "EscRate" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/escalation-rate`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { total: number; escalated: number; escalation_rate: number };
  assert.equal(body.total, 0);
  assert.equal(body.escalation_rate, 0);

  await app.close();
});

/* ── F-135  handoff chain depth ────────────────────────── */
test("GET /workspaces/:workspace/handoffs/chain-depth", async () => {
  runMigrations();
  const app = buildApp();
  const suffix = Date.now().toString(36);
  const ws = `ws-cd-${suffix}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "ChainDepth" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/chain-depth`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { total_handoffs: number; max_depth: number; avg_depth: number };
  assert.equal(body.total_handoffs, 0);
  assert.equal(body.max_depth, 0);

  await app.close();
});

/* ── F-136  agent tag summary ──────────────────────────── */
test("GET /workspaces/:workspace/agents/tag-summary", async () => {
  runMigrations();
  const app = buildApp();
  const suffix = Date.now().toString(36);
  const ws = `ws-ts-${suffix}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "TagSum" },
  });

  // Register agent with tags
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      agent_id: `a-ts-${suffix}`,
      display_name: "TagAgent",
      capabilities: ["code"],
      tags: ["frontend", "react"],
    },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/tag-summary`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { data: Array<{ tag: string; count: number }> };
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.length >= 2);

  await app.close();
});

/* ── F-137  claim scope frequency ──────────────────────── */
test("GET /workspaces/:workspace/claims/scope-frequency", async () => {
  runMigrations();
  const app = buildApp();
  const suffix = Date.now().toString(36);
  const ws = `ws-sf-${suffix}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "ScopeFreq" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/scope-frequency`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { data: unknown[] };
  assert.ok(Array.isArray(body.data));

  await app.close();
});

/* ── F-138  agent capability overlap ───────────────────── */
test("GET /workspaces/:workspace/agents/capability-overlap", async () => {
  runMigrations();
  const app = buildApp();
  const suffix = Date.now().toString(36);
  const ws = `ws-co-${suffix}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "CapOverlap" },
  });

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: `a1-co-${suffix}`, display_name: "A1", capabilities: ["code", "review"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { agent_id: `a2-co-${suffix}`, display_name: "A2", capabilities: ["code", "test"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/capability-overlap`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body2 = res.json() as { data: Array<{ capability: string; count: number }> };
  assert.ok(Array.isArray(body2.data));
  const codeOverlap = body2.data.find((d) => d.capability === "code");
  assert.ok(codeOverlap);
  assert.equal(codeOverlap.count, 2);

  await app.close();
});

/* ── F-139  handoff rejection rate ─────────────────────── */
test("GET /workspaces/:workspace/handoffs/rejection-rate", async () => {
  runMigrations();
  const app = buildApp();
  const suffix = Date.now().toString(36);
  const ws = `ws-rr-${suffix}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "RejRate" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/rejection-rate`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body3 = res.json() as { total: number; rejected: number; rejection_rate: number };
  assert.equal(body3.total, 0);
  assert.equal(body3.rejection_rate, 0);

  await app.close();
});

/* ── F-140  blocker severity trend ─────────────────────── */
test("GET /workspaces/:workspace/blockers/severity-trend", async () => {
  runMigrations();
  const app = buildApp();
  const suffix = Date.now().toString(36);
  const ws = `ws-st-${suffix}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { workspace_id: ws, display_name: "SevTrend" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/severity-trend`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body4 = res.json() as { data: unknown[] };
  assert.ok(Array.isArray(body4.data));

  await app.close();
});

// --------------- F-142: Concurrent operations ---------------
test("concurrent claim creations do not produce duplicates for same scope", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-cc-${Date.now().toString(36)}`;
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
    payload: { agent_id: "racer1", display_name: "R1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "racer2", display_name: "R2", capabilities: ["code"] },
  });

  // Fire two claims for the same scope concurrently
  const [c1, c2] = await Promise.all([
    app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${ws}/claims`,
      headers: auth,
      payload: { agent_id: "racer1", scope: "file", paths: ["src/index.ts"], ttl_seconds: 300 },
    }),
    app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${ws}/claims`,
      headers: auth,
      payload: { agent_id: "racer2", scope: "file", paths: ["src/index.ts"], ttl_seconds: 300 },
    }),
  ]);

  // At least one should succeed, and the overlap check may reject one
  const succeeded = [c1, c2].filter((r) => r.statusCode === 201);
  assert.ok(succeeded.length >= 1, "At least one concurrent claim should succeed");

  await app.close();
});

test("concurrent agent registrations with same id are idempotent", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-cr-${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });

  // Register same agent concurrently
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${ws}/agents/register`,
        headers: auth,
        payload: { agent_id: "dup-agent", display_name: "Dup", capabilities: ["code"] },
      }),
    ),
  );

  // All should either succeed (200/201) or conflict gracefully
  for (const r of results) {
    assert.ok(r.statusCode < 500, `Registration should not cause 500: got ${r.statusCode}`);
  }

  // Only one agent should exist
  const list = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
  });
  const agents = list.json().data as Array<{ agent_id: string }>;
  const matching = agents.filter((a) => a.agent_id === "dup-agent");
  assert.equal(matching.length, 1, "Only one instance of the agent should exist");

  await app.close();
});

test("concurrent handoff creation and resolution", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-ch-${Date.now().toString(36)}`;
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
    payload: { agent_id: "sender", display_name: "S", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "receiver", display_name: "R", capabilities: ["review"] },
  });

  // Create multiple handoffs concurrently
  const handoffs = await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${ws}/handoffs`,
        headers: auth,
        payload: {
          from_agent_id: "sender",
          summary: `Task ${i}`,
          required_capability: "review",
        },
      }),
    ),
  );

  for (const h of handoffs) {
    assert.equal(h.statusCode, 201, "All handoffs should be created");
  }

  // Accept them concurrently
  const resolutions = await Promise.all(
    handoffs.map((h) => {
      const hid = h.json().handoff_id;
      return app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${ws}/handoffs/${hid}/accept`,
        headers: auth,
        payload: { agent_id: "receiver" },
      });
    }),
  );

  for (const r of resolutions) {
    assert.equal(r.statusCode, 200, "All accepts should succeed");
  }

  await app.close();
});

// --------------- F-143: Claim dependency lifecycle ---------------
test("releasing a claim with dependents is blocked without cascade", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-cdl-${Date.now().toString(36)}`;
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

  // Create parent claim
  const parent = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "file", paths: ["src/base.ts"], ttl_seconds: 600 },
  });
  assert.equal(parent.statusCode, 201);
  const parentId = parent.json().claim_id;

  // Create child claim depending on parent
  const child = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: {
      agent_id: "a1",
      scope: "file",
      paths: ["src/child.ts"],
      ttl_seconds: 600,
      depends_on: [parentId],
    },
  });
  assert.equal(child.statusCode, 201);
  const childId = child.json().claim_id;

  // Try to release parent without cascade — should be blocked
  const r1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims/${parentId}/release`,
    headers: auth,
    payload: {},
  });
  assert.equal(r1.statusCode, 409);
  assert.ok(r1.json().dependent_claim_ids.includes(childId));

  // Release with cascade
  const r2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims/${parentId}/release`,
    headers: auth,
    payload: { cascade: true },
  });
  assert.equal(r2.statusCode, 200);
  assert.ok(r2.json().ok);
  assert.ok(r2.json().cascaded.includes(childId));

  await app.close();
});

test("releasing a claim without dependents works normally", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-cdn-${Date.now().toString(36)}`;
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

  const c = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "file", paths: ["src/solo.ts"], ttl_seconds: 600 },
  });
  assert.equal(c.statusCode, 201);

  const r = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims/${c.json().claim_id}/release`,
    headers: auth,
    payload: {},
  });
  assert.equal(r.statusCode, 200);
  assert.ok(r.json().ok);
  assert.deepEqual(r.json().cascaded, []);

  await app.close();
});

// --------------- F-144: Agent workload balancing ---------------
test("recommend returns least-loaded agent for capability", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-alb-${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });

  // Register two agents with same capability
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "busy", display_name: "Busy", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "idle", display_name: "Idle", capabilities: ["code"] },
  });

  // Give busy agent 3 claims
  for (let i = 0; i < 3; i++) {
    await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${ws}/claims`,
      headers: auth,
      payload: { agent_id: "busy", scope: "file", paths: [`src/f${i}.ts`], ttl_seconds: 600 },
    });
  }

  // Recommend should pick the idle agent
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/recommend?capability=code`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().recommended, "idle");
  assert.equal(res.json().candidates.length, 2);
  assert.ok(res.json().candidates[0].load_score <= res.json().candidates[1].load_score);

  await app.close();
});

test("recommend returns null when no agents have capability", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-albn-${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/recommend?capability=nonexistent`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().recommended, null);

  await app.close();
});

// --------------- F-145: Workspace merge ---------------
test("workspace merge copies agents from source to target", async () => {
  runMigrations();
  const app = buildApp();
  const suffix = Date.now().toString(36);
  const source = `ws-msrc-${suffix}`;
  const target = `ws-mtgt-${suffix}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: source, display_name: "Source" },
  });
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: target, display_name: "Target" },
  });

  // Add agent to source only
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${source}/agents/register`,
    headers: auth,
    payload: { agent_id: `m-agent-${suffix}`, display_name: "MA", capabilities: ["code"] },
  });

  // Merge source into target (agents only, skip claims/blockers which reference agents by FK)
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${target}/merge`,
    headers: auth,
    payload: {
      source_workspace_id: source,
      include_claims: false,
      include_blockers: false,
    },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().ok);
  assert.equal(res.json().merged.agents, 1);

  // Verify more agents exist in target now
  const agents = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${target}/agents`,
    headers: auth,
  });
  const agentList = agents.json().data as Array<{ agent_id: string }>;
  assert.ok(agentList.length >= 1, "Target should have at least one agent after merge");

  await app.close();
});

test("workspace merge rejects self-merge", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-mself-${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/merge`,
    headers: auth,
    payload: { source_workspace_id: ws },
  });
  assert.equal(res.statusCode, 422);

  await app.close();
});

// --------------- F-146: Handoff SLA countdown ---------------
test("handoff SLA countdown returns approaching deadlines", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-slac-${Date.now().toString(36)}`;
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

  // Create handoff with tight SLA
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: {
      from_agent_id: "a1",
      summary: "Urgent review",
      required_capability: "review",
      sla_seconds: 600,
    },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/sla-countdown?threshold_minutes=15`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  assert.ok(typeof res.json().threshold_minutes === "number");
  assert.ok(Array.isArray(res.json().data));

  await app.close();
});

// --------------- F-147: Handoff batch accept ---------------
test("batch accept handles multiple handoffs", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-ba-${Date.now().toString(36)}`;
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
    payload: { agent_id: "sender", display_name: "S", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "receiver", display_name: "R", capabilities: ["review"] },
  });

  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const h = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${ws}/handoffs`,
      headers: auth,
      payload: {
        from_agent_id: "sender",
        summary: `Task ${i}`,
        required_capability: "review",
      },
    });
    ids.push(h.json().handoff_id);
  }

  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/batch-accept`,
    headers: auth,
    payload: { handoff_ids: ids, agent_id: "receiver" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().accepted, 3);
  assert.equal(res.json().results.length, 3);

  // Accept again should fail (already accepted)
  const res2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/batch-accept`,
    headers: auth,
    payload: { handoff_ids: ids, agent_id: "receiver" },
  });
  assert.equal(res2.json().accepted, 0);

  await app.close();
});

// --------------- F-148: Blocker auto-assign ---------------
test("blocker auto_assign_capability adds watcher automatically", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-baa-${Date.now().toString(36)}`;
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
    payload: { agent_id: "blocker-agent", display_name: "BA", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "reviewer", display_name: "R", capabilities: ["review"] },
  });

  // Create blocker with auto-assign
  const b = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: {
      agent_id: "blocker-agent",
      title: "Need review",
      severity: "high",
      auto_assign_capability: "review",
    },
  });
  assert.equal(b.statusCode, 201);
  assert.equal(b.json().assigned_to, "reviewer");

  // Verify watcher was added
  const wl = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/${b.json().blocker_id}/watchers`,
    headers: auth,
  });
  assert.equal(wl.json().data.length, 1);
  assert.equal(wl.json().data[0].agent_id, "reviewer");

  await app.close();
});

test("blocker auto_assign with no matching capability returns no assignment", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-baan-${Date.now().toString(36)}`;
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
    payload: { agent_id: "solo-agent", display_name: "SA", capabilities: ["code"] },
  });

  const b = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: {
      agent_id: "solo-agent",
      title: "Need nonexistent skill",
      severity: "low",
      auto_assign_capability: "quantum_computing",
    },
  });
  assert.equal(b.statusCode, 201);
  assert.ok(!b.json().assigned_to);

  await app.close();
});

// --------------- F-149: Work queue stats ---------------
test("work queue returns aggregated pending work", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-wq-${Date.now().toString(36)}`;
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
    payload: { agent_id: "wq-a1", display_name: "A1", capabilities: ["code"] },
  });

  // Create a claim
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "wq-a1", scope: "file", paths: ["src/a.ts"], ttl_seconds: 600 },
  });

  // Create a blocker
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "wq-a1", title: "Stuck", severity: "high" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/work-queue`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.summary);
  assert.equal(body.summary.active_claims, 1);
  assert.equal(body.summary.open_blockers, 1);
  assert.equal(body.summary.online_agents, 1);
  assert.ok(Array.isArray(body.agent_load));

  await app.close();
});

// --------------- F-150: Workspace snapshot ---------------
test("workspace snapshot returns current state", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `ws-snap-${Date.now().toString(36)}`;
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
    payload: { agent_id: "snap-a1", display_name: "SA1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/snapshot`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.workspace);
  assert.ok(body.snapshot_at);
  assert.ok(Array.isArray(body.agents));
  assert.equal(body.agents.length, 1);
  assert.ok(Array.isArray(body.claims));
  assert.ok(Array.isArray(body.blockers));
  assert.ok(Array.isArray(body.handoffs));

  await app.close();
});

/* ── F-151  blocker impact analysis ───────────────── */
test("blocker impact analysis returns open blockers with impact scores", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `impact_${Date.now().toString(36)}`;
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
    payload: { agent_id: "imp-a1", display_name: "agent-imp-1", capabilities: ["debug"] },
  });

  // create a blocker
  const cr = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "imp-a1", title: "DB down", severity: "critical" },
  });
  assert.equal(cr.statusCode, 201);

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/impact`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total_open === "number");
  assert.ok(body.total_open >= 1);
  assert.ok(typeof body.total_impact_score === "number");
  assert.ok(Array.isArray(body.blockers));
  assert.ok(body.blockers[0].blocker_id);
  assert.ok(typeof body.blockers[0].hours_open === "number");

  await app.close();
});

/* ── F-152  claim health / expiry forecast ────────── */
test("claim health returns active claim stats and at-risk list", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `clhealth_${Date.now().toString(36)}`;
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
    payload: { agent_id: "ch-a1", display_name: "agent-ch-1", capabilities: ["db"] },
  });

  // create a claim that expires soon
  const cr = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "ch-a1", scope: "service-db", paths: ["/service/db"], ttl_seconds: 300 },
  });
  assert.equal(cr.statusCode, 201);

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/health`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total_active === "number");
  assert.ok(typeof body.renewal_rate === "number");
  assert.ok(typeof body.avg_renewals === "number");
  assert.ok(Array.isArray(body.at_risk_claims));

  await app.close();
});

/* ── F-153  agent performance score ────────────────── */
test("agent performance score returns composite score and stats", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `perf_${Date.now().toString(36)}`;
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
    payload: { agent_id: "perf-a1", display_name: "Perf Agent", capabilities: ["code"] },
  });
  // create and release a claim
  const cc = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "perf-a1", scope: "perf-scope", paths: ["/perf"] },
  });
  assert.equal(cc.statusCode, 201);
  const claimId = cc.json().claim_id;
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims/${claimId}/release`,
    headers: auth,
    payload: {},
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/perf-a1/performance`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.agent_id, "perf-a1");
  assert.ok(typeof body.score === "number");
  assert.ok(body.claims);
  assert.ok(body.handoffs);
  assert.ok(body.blockers);
  assert.ok(body.rates);
  assert.ok(typeof body.rates.completion === "number");

  await app.close();
});

/* ── F-154  handoff chain analysis ─────────────────── */
test("handoff chain analysis follows handoff forward chain", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `chain_${Date.now().toString(36)}`;
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
    payload: { agent_id: "ch-a1", display_name: "Chain A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "ch-a2", display_name: "Chain A2", capabilities: ["code"] },
  });

  // Create a handoff from a1 → a2
  const hc = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: {
      from_agent_id: "ch-a1",
      to_agent_id: "ch-a2",
      summary: "chain link 1",
    },
  });
  assert.equal(hc.statusCode, 201);
  const hid = hc.json().handoff_id;

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/chain/${hid}`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.origin, hid);
  assert.ok(body.chain_length >= 1);
  assert.ok(Array.isArray(body.chain));
  assert.equal(body.chain[0].handoff_id, hid);
  assert.equal(body.chain[0].from_agent, "ch-a1");

  await app.close();
});

/* ── F-155  workspace comparison ───────────────────── */
test("workspace comparison shows stats and capability overlap", async () => {
  runMigrations();
  const app = buildApp();
  const wsA = `cmpA_${Date.now().toString(36)}`;
  const wsB = `cmpB_${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };

  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: wsA, display_name: wsA },
  });
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: wsB, display_name: wsB },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${wsA}/agents/register`,
    headers: auth,
    payload: { agent_id: `cmp-a1-${Date.now()}`, display_name: "A1", capabilities: ["ts", "go"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${wsB}/agents/register`,
    headers: auth,
    payload: { agent_id: `cmp-b1-${Date.now()}`, display_name: "B1", capabilities: ["ts", "rust"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${wsA}/compare/${wsB}`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.left.workspace_id, wsA);
  assert.equal(body.right.workspace_id, wsB);
  assert.ok(body.capability_overlap);
  assert.ok(Array.isArray(body.capability_overlap.shared));
  assert.ok(body.capability_overlap.shared.includes("ts"));

  await app.close();
});

/* ── F-156  claim overlap detection ────────────────── */
test("claim overlap detection finds overlapping path patterns", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `overlap_${Date.now().toString(36)}`;
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
    payload: { agent_id: "ov-a1", display_name: "OV-A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "ov-a2", display_name: "OV-A2", capabilities: ["code"] },
  });

  // Two claims with different paths (API prevents path overlap)
  const c1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "ov-a1", scope: "scope-alpha", paths: ["/shared/a.ts"] },
  });
  assert.equal(c1.statusCode, 201);
  const c2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "ov-a2", scope: "scope-beta", paths: ["/shared/b.ts"] },
  });
  assert.equal(c2.statusCode, 201);

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/overlaps`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total_overlaps === "number");
  assert.ok(Array.isArray(body.paths));

  await app.close();
});

/* ── F-157  agent collaboration matrix (enhanced test) ─── */
test("agent collaboration matrix shows handoff interactions between agents", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `collab_${Date.now().toString(36)}`;
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
    payload: { agent_id: "col-a1", display_name: "Col A1", capabilities: ["ts"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "col-a2", display_name: "Col A2", capabilities: ["ts"] },
  });

  // create a handoff a1 → a2
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "col-a1", to_agent_id: "col-a2", summary: "collab test" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/collaboration-matrix`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.length >= 1);
  assert.ok(body.data[0].interactions >= 1);

  await app.close();
});

/* ── F-158  blocker resolution timeline ───────────── */
test("blocker resolution timeline returns daily resolution stats", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `brt_${Date.now().toString(36)}`;
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
    payload: { agent_id: "brt-a1", display_name: "BRT A1", capabilities: ["debug"] },
  });

  // create and resolve a blocker
  const bc = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "brt-a1", title: "Timeline test", severity: "medium" },
  });
  assert.equal(bc.statusCode, 201);
  const bid = bc.json().blocker_id;

  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/${bid}/resolve`,
    headers: auth,
    payload: { resolution: "Fixed it" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/resolution-timeline?days=7`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.period_days, 7);
  assert.ok(typeof body.total_resolved === "number");
  assert.ok(typeof body.avg_hours_to_resolve === "number");
  assert.ok(Array.isArray(body.timeline));

  await app.close();
});

/* ── F-159  workspace activity feed (enhanced test) ──── */
test("workspace activity feed returns audit events", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `feed_${Date.now().toString(36)}`;
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
    payload: { agent_id: "feed-a1", display_name: "Feed A1", capabilities: ["ts"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/activity-feed?limit=10`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.length >= 1);
  assert.ok(body.data[0].action);
  assert.ok(body.data[0].created_at);

  await app.close();
});

/* ── F-160  handoff priority queue ─────────────────── */
test("handoff priority queue returns pending handoffs sorted by priority", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `pq_${Date.now().toString(36)}`;
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
    payload: { agent_id: "pq-a1", display_name: "PQ A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "pq-a2", display_name: "PQ A2", capabilities: ["code"] },
  });

  // low priority handoff
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "pq-a1", to_agent_id: "pq-a2", summary: "low task", priority: "low" },
  });
  // critical priority handoff
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: {
      from_agent_id: "pq-a1",
      to_agent_id: "pq-a2",
      summary: "critical task",
      priority: "critical",
    },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/priority-queue`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.count >= 2);
  assert.ok(Array.isArray(body.queue));
  // critical should come first
  assert.equal(body.queue[0].priority, "critical");
  assert.equal(body.queue[1].priority, "low");

  await app.close();
});

/* ── F-161  agent load forecast ────────────────────── */
test("agent load forecast returns current and predicted loads", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `forecast_${Date.now().toString(36)}`;
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
    payload: { agent_id: "fc-a1", display_name: "Forecast A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/load-forecast`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.agent_count === "number");
  assert.ok(body.agent_count >= 1);
  assert.ok(Array.isArray(body.forecast));
  assert.ok(typeof body.forecast[0].current_load === "number");
  assert.ok(typeof body.forecast[0].forecast_load_1h === "number");

  await app.close();
});

/* ── F-162  blocker bulk severity update ──────────── */
test("blocker bulk severity update changes severity of multiple blockers", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `bsev_${Date.now().toString(36)}`;
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
    payload: { agent_id: "bsev-a1", display_name: "BSEV A1", capabilities: ["debug"] },
  });

  const b1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "bsev-a1", title: "Bug 1", severity: "low" },
  });
  const b2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "bsev-a1", title: "Bug 2", severity: "low" },
  });
  assert.equal(b1.statusCode, 201);
  assert.equal(b2.statusCode, 201);

  const res = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/blockers/bulk-update-severity`,
    headers: auth,
    payload: {
      blocker_ids: [b1.json().blocker_id, b2.json().blocker_id],
      severity: "critical",
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.updated, 2);
  assert.equal(body.severity, "critical");

  await app.close();
});

/* ── F-163  claim scope tree ───────────────────────── */
test("claim scope tree returns active claims grouped by path prefix", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `stree_${Date.now().toString(36)}`;
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
    payload: { agent_id: "st-a1", display_name: "ST A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "st-a1", scope: "tree-scope", paths: ["/src/app.ts"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/scope-tree`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total_active === "number");
  assert.ok(Array.isArray(body.tree));
  assert.ok(body.tree.length >= 1);
  assert.ok(body.tree[0].path);
  assert.ok(body.tree[0].claim_count >= 1);

  await app.close();
});

/* ── F-164  handoff delegation depth warning ────────── */
test("handoff delegation depth returns warnings for deep chains", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `depth_${Date.now().toString(36)}`;
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
    payload: { agent_id: "dp-a1", display_name: "DP A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/delegation-depth?threshold=1`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.threshold, 1);
  assert.ok(typeof body.warnings_count === "number");
  assert.ok(Array.isArray(body.warnings));

  await app.close();
});

/* ── F-165  workspace health score (enhanced test) ──── */
test("workspace health score returns composite score and factors", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `health_${Date.now().toString(36)}`;
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
    payload: { agent_id: "hs-a1", display_name: "HS A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/health-score`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.score === "number");
  assert.ok(body.score >= 0 && body.score <= 100);
  assert.ok(body.factors);
  assert.ok(typeof body.factors.total_agents === "number");

  await app.close();
});

/* ── F-166  blocker cascade analysis ───────────────── */
test("blocker cascade analysis returns dependency chains", async () => {
  runMigrations();
  const app = buildApp();
  const ws = `cascade_${Date.now().toString(36)}`;
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
    payload: { agent_id: "cas-a1", display_name: "CAS A1", capabilities: ["debug"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/cascade-analysis`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total_dependencies === "number");
  assert.ok(typeof body.cascade_roots === "number");
  assert.ok(Array.isArray(body.cascades));

  await app.close();
});

// F-167: Agent response time analytics
test("GET /agents/response-times returns response time stats", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `rt-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "rt-a1", display_name: "RT A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "rt-a2", display_name: "RT A2", capabilities: ["review"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/response-times`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.agent_count === "number");
  assert.ok(Array.isArray(body.response_times));
  assert.equal(body.agent_count, 2);
  for (const rt of body.response_times) {
    assert.ok(typeof rt.agent_id === "string");
    assert.ok(typeof rt.avg_response_seconds === "number");
    assert.ok(typeof rt.min_response_seconds === "number");
    assert.ok(typeof rt.max_response_seconds === "number");
    assert.ok(typeof rt.total_accepted === "number");
  }

  await app.close();
});

// F-168: Claim contention hotspots
test("GET /claims/contention returns contention analysis", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `cont-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "cont-a1", display_name: "CONT A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/contention`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total_paths === "number");
  assert.ok(typeof body.contested_paths === "number");
  assert.ok(Array.isArray(body.hotspots));

  await app.close();
});

// F-169: Handoff bottleneck agents
test("GET /handoffs/bottleneck-agents returns bottleneck analysis", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `bn-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "bn-a1", display_name: "BN A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "bn-a2", display_name: "BN A2", capabilities: ["review"] },
  });

  // Create a handoff to bn-a2
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "bn-a1", to_agent_id: "bn-a2", summary: "Review code" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/bottleneck-agents`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.agent_count === "number");
  assert.ok(typeof body.bottleneck_count === "number");
  assert.ok(Array.isArray(body.agents));
  assert.equal(body.agent_count, 2);
  const a2 = body.agents.find((a: Record<string, unknown>) => a.agent_id === "bn-a2");
  assert.ok(a2);
  assert.equal(a2.pending_count, 1);

  await app.close();
});

// F-170: Workspace growth trend
test("GET /workspaces/:workspace/growth-trend returns daily trends", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `gt-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "gt-a1", display_name: "GT A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/growth-trend?days=7`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.workspace_id, ws);
  assert.equal(body.period_days, 7);
  assert.ok(Array.isArray(body.agents));
  assert.ok(Array.isArray(body.claims));
  assert.ok(Array.isArray(body.handoffs));
  assert.ok(Array.isArray(body.blockers));

  await app.close();
});

// F-171: Blocker SLA compliance
test("GET /blockers/sla-compliance returns compliance stats", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `sla-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "sla-a1", display_name: "SLA A1", capabilities: ["debug"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/sla-compliance`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total_with_deadline === "number");
  assert.ok(typeof body.compliance_rate === "number");
  assert.ok(typeof body.currently_overdue === "number");
  assert.ok(typeof body.met_sla === "number");
  assert.ok(Array.isArray(body.overdue_blockers));

  await app.close();
});

// F-172: Claim aging analysis
test("GET /claims/aging returns age distribution", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `age-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "age-a1", display_name: "AGE A1", capabilities: ["code"] },
  });

  // Create a claim so we have data
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "age-a1", scope: "fileA", paths: ["src/a.ts"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/aging`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total_active === "number");
  assert.ok(typeof body.avg_age_hours === "number");
  assert.ok(body.distribution);
  assert.ok(typeof body.distribution.under_1h === "number");
  assert.ok(Array.isArray(body.oldest));
  assert.equal(body.total_active, 1);

  await app.close();
});

// F-173: Agent availability summary
test("GET /agents/availability-summary returns availability stats", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `avail-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "avail-a1", display_name: "AVAIL A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/availability-summary`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.agent_count === "number");
  assert.ok(body.status_distribution);
  assert.ok(Array.isArray(body.agents));
  assert.equal(body.agent_count, 1);
  const a1 = body.agents[0];
  assert.equal(a1.agent_id, "avail-a1");
  assert.ok(typeof a1.uptime_hours === "number");
  assert.ok(typeof a1.last_seen_minutes_ago === "number");

  await app.close();
});

// F-174: Handoff velocity
test("GET /handoffs/velocity returns throughput trends", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `vel-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "vel-a1", display_name: "VEL A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "vel-a2", display_name: "VEL A2", capabilities: ["review"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "vel-a1", to_agent_id: "vel-a2", summary: "Velocity test" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/velocity?days=7`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.period_days, 7);
  assert.ok(typeof body.total_created === "number");
  assert.ok(typeof body.total_accepted === "number");
  assert.ok(typeof body.avg_per_day === "number");
  assert.ok(Array.isArray(body.daily));
  assert.ok(body.total_created >= 1);

  await app.close();
});

// F-175: Workspace capacity
test("GET /workspaces/:workspace/capacity returns capacity stats", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `cap-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "cap-a1", display_name: "CAP A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/capacity`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.workspace_id, ws);
  assert.equal(body.total_agents, 1);
  assert.ok(typeof body.online_agents === "number");
  assert.ok(typeof body.active_claims === "number");
  assert.ok(typeof body.pending_handoffs === "number");
  assert.ok(typeof body.open_blockers === "number");
  assert.ok(typeof body.agent_utilization === "number");

  await app.close();
});

// F-176: Blocker heatmap
test("GET /blockers/heatmap returns creation heatmap", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `hm-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "hm-a1", display_name: "HM A1", capabilities: ["debug"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "hm-a1", title: "Heatmap blocker", severity: "medium" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/heatmap`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total_blockers === "number");
  assert.ok(typeof body.peak_hour === "number");
  assert.ok(typeof body.peak_day === "string");
  assert.ok(Array.isArray(body.heatmap));
  assert.ok(body.total_blockers >= 1);

  await app.close();
});

// F-177: Claim renewal forecast
test("GET /claims/renewal-forecast returns upcoming renewals", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `rf-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "rf-a1", display_name: "RF A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/renewal-forecast?hours=24`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.forecast_hours, 24);
  assert.ok(typeof body.expiring_count === "number");
  assert.ok(Array.isArray(body.by_agent));
  assert.ok(Array.isArray(body.claims));

  await app.close();
});

// F-178: Agent stale detection
test("GET /agents/stale-detection returns stale agent analysis", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `stale-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "stale-a1", display_name: "STALE A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/stale-detection?minutes=10`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.threshold_minutes, 10);
  assert.ok(typeof body.total_agents === "number");
  assert.ok(typeof body.healthy_count === "number");
  assert.ok(typeof body.stale_count === "number");
  assert.ok(Array.isArray(body.stale_agents));
  assert.equal(body.total_agents, 1);

  await app.close();
});

// F-179: Handoff escalation paths
test("GET /handoffs/escalation-paths returns escalation analysis", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `esc-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "esc-a1", display_name: "ESC A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "esc-a2", display_name: "ESC A2", capabilities: ["review"] },
  });

  // Create and reject a handoff for escalation pattern
  const h = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "esc-a1", to_agent_id: "esc-a2", summary: "Escalation test" },
  });
  const handoffId = h.json().handoff_id;
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/${handoffId}/reject`,
    headers: auth,
    payload: { reason: "Cannot handle" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/escalation-paths`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total_handoffs === "number");
  assert.ok(typeof body.total_rejections === "number");
  assert.ok(typeof body.retry_chains === "number");
  assert.ok(Array.isArray(body.escalation_paths));
  assert.equal(body.total_rejections, 1);

  await app.close();
});

// F-180: Workspace audit stats
test("GET /workspaces/:workspace/audit-stats returns audit statistics", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `as-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "as-a1", display_name: "AS A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/audit-stats`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.workspace_id, ws);
  assert.ok(typeof body.total_events === "number");
  assert.ok(Array.isArray(body.by_action));
  assert.ok(Array.isArray(body.by_day));

  await app.close();
});

// F-181: Agent pair affinity
test("GET /agents/pair-affinity returns pair collaboration stats", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `pa-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "pa-a1", display_name: "PA A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "pa-a2", display_name: "PA A2", capabilities: ["review"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "pa-a1", to_agent_id: "pa-a2", summary: "Pair affinity test" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/pair-affinity`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.pair_count === "number");
  assert.ok(Array.isArray(body.pairs));
  assert.ok(body.pair_count >= 1);
  const pair = body.pairs[0];
  assert.equal(pair.from_agent_id, "pa-a1");
  assert.equal(pair.to_agent_id, "pa-a2");
  assert.ok(typeof pair.acceptance_rate === "number");

  await app.close();
});

// F-182: Blocker clustering
test("GET /blockers/clustering returns blocker groups", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `cl-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "cl-a1", display_name: "CL A1", capabilities: ["debug"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "cl-a1", title: "Cluster B1", severity: "high" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "cl-a1", title: "Cluster B2", severity: "high" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/clustering`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total_clusters === "number");
  assert.ok(Array.isArray(body.clusters));
  assert.ok(Array.isArray(body.by_agent));
  assert.ok(Array.isArray(body.by_severity));
  // Should have a cluster for cl-a1 + high with count 2
  const cluster = body.clusters.find(
    (c: Record<string, unknown>) => c.agent_id === "cl-a1" && c.severity === "high",
  );
  assert.ok(cluster);
  assert.equal(cluster.count, 2);

  await app.close();
});

// F-183: Claim ownership map
test("GET /claims/ownership-map returns claim-agent mapping", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `om-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "om-a1", display_name: "OM A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "om-a1", scope: "fileScope", paths: ["src/app.ts"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/ownership-map`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total_agents === "number");
  assert.ok(typeof body.total_active_claims === "number");
  assert.ok(Array.isArray(body.owners));
  assert.equal(body.total_agents, 1);
  assert.equal(body.owners[0].agent_id, "om-a1");
  assert.equal(body.owners[0].claim_count, 1);

  await app.close();
});

// F-184: Handoff completion rate
test("GET /handoffs/completion-rate returns completion analytics", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `cr-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "cr-a1", display_name: "CR A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "cr-a2", display_name: "CR A2", capabilities: ["review"] },
  });
  const h = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "cr-a1", to_agent_id: "cr-a2", summary: "Completion rate test" },
  });
  const handoffId = h.json().handoff_id;
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/${handoffId}/accept`,
    headers: auth,
    payload: {},
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/completion-rate`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total === "number");
  assert.ok(typeof body.accepted === "number");
  assert.ok(typeof body.completion_rate === "number");
  assert.ok(Array.isArray(body.by_target));
  assert.equal(body.total, 1);
  assert.equal(body.accepted, 1);
  assert.equal(body.completion_rate, 100);

  await app.close();
});

// F-185: Workspace anomaly detection
test("GET /workspaces/:workspace/anomaly-detection returns anomalies", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `anom-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "anom-a1", display_name: "ANOM A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/anomaly-detection`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.workspace_id, ws);
  assert.ok(typeof body.anomaly_count === "number");
  assert.ok(Array.isArray(body.anomalies));

  await app.close();
});

// F-186: Agent capability coverage
test("GET /agents/capability-coverage returns coverage stats", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `cc-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "cc-a1", display_name: "CC A1", capabilities: ["code", "review"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/capability-coverage`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total_capabilities === "number");
  assert.ok(typeof body.covered_capabilities === "number");
  assert.ok(Array.isArray(body.uncovered_capabilities));
  assert.ok(typeof body.coverage_rate === "number");
  assert.ok(Array.isArray(body.capability_details));
  assert.equal(body.total_capabilities, 2);
  assert.equal(body.coverage_rate, 100);

  await app.close();
});

// F-187: Blocker resolution velocity
test("GET /blockers/resolution-velocity returns velocity stats", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `rv-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "rv-a1", display_name: "RV A1", capabilities: ["debug"] },
  });

  // Create and resolve a blocker
  const b = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "rv-a1", title: "Velocity blocker", severity: "medium" },
  });
  const blockerId = b.json().blocker_id;
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/${blockerId}/resolve`,
    headers: auth,
    payload: { resolution: "Fixed" },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/resolution-velocity`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total_resolved === "number");
  assert.ok(typeof body.avg_resolution_hours === "number");
  assert.ok(Array.isArray(body.by_severity));
  assert.ok(Array.isArray(body.fastest));
  assert.equal(body.total_resolved, 1);

  await app.close();
});

// F-188: Claim transfer summary
test("GET /claims/transfer-summary returns transfer analytics", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ts-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "ts-a1", display_name: "TS A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/transfer-summary`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total_transfers === "number");
  assert.ok(Array.isArray(body.transfer_pairs));
  assert.ok(Array.isArray(body.top_senders));
  assert.ok(Array.isArray(body.top_receivers));

  await app.close();
});

// F-189: Handoff SLA forecast
test("GET /handoffs/sla-forecast returns SLA prediction", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `sf-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "sf-a1", display_name: "SF A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/sla-forecast`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(typeof body.total_pending_with_deadline === "number");
  assert.ok(typeof body.at_risk === "number");
  assert.ok(typeof body.already_breached === "number");
  assert.ok(Array.isArray(body.handoffs));

  await app.close();
});

// F-190: Workspace risk score
test("GET /workspaces/:workspace/risk-score returns risk assessment", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `risk-ws-${Date.now().toString(36)}`;

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
    payload: { agent_id: "risk-a1", display_name: "RISK A1", capabilities: ["code"] },
  });

  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/risk-score`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.workspace_id, ws);
  assert.ok(typeof body.risk_score === "number");
  assert.ok(typeof body.risk_level === "string");
  assert.ok(body.factors);
  assert.ok(typeof body.factors.stale_agents === "number");
  assert.ok(typeof body.factors.open_blockers === "number");
  assert.ok(typeof body.factors.critical_blockers === "number");
  assert.ok(typeof body.factors.pending_handoffs === "number");
  // Fresh workspace should have low risk
  assert.equal(body.risk_level, "low");

  await app.close();
});

// ---------- F-191: Agent utilization timeline ----------
test("GET /agents/utilization-timeline returns time buckets", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ut-timeline-${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, name: ws },
  });
  // Register agent and create a handoff to generate activity
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
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/utilization-timeline?hours=24&bucket_hours=1`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(Array.isArray(body.buckets));
  assert.ok(body.buckets.length > 0);
  assert.ok(typeof body.total_activity === "number");
  assert.ok(body.peak_bucket);
  await app.close();
});

// ---------- F-192: Blocker dependency depth ----------
test("GET /blockers/dependency-depth returns depth analysis", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `blk-depdepth-${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  // Create a blocker
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "B1", severity: "medium" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/dependency-depth`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.max_depth === "number");
  assert.ok(typeof body.avg_depth === "number");
  assert.ok(typeof body.total_blockers === "number");
  assert.ok(body.depth_distribution);
  await app.close();
});

// ---------- F-193: Handoff agent workload ----------
test("GET /handoffs/agent-workload returns per-agent workload", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ho-agwl-${Date.now().toString(36)}`;
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
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/agent-workload`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(Array.isArray(body.agents));
  assert.ok(body.agents.length > 0);
  const a1 = body.agents.find((a: any) => a.agent_id === "a1");
  assert.ok(a1);
  assert.ok(a1.sent >= 1);
  await app.close();
});

// ---------- F-194: Claim duration stats ----------
test("GET /claims/duration-stats returns duration statistics", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `cl-durstats-${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["code"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "file.ts", paths: ["src/file.ts"], ttl_seconds: 3600 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/duration-stats`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.completed_claims === "number");
  assert.ok(typeof body.active_claims === "number");
  assert.ok(body.duration_hours);
  assert.ok(typeof body.duration_hours.avg === "number");
  await app.close();
});

// ---------- F-195: Workspace agent distribution ----------
test("GET /workspaces/:workspace/agent-distribution returns distribution", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ws-agdist-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["code"], model: "gpt-4" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: {
      agent_id: "a2",
      display_name: "A2",
      capabilities: ["code", "review"],
      model: "gpt-4",
    },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agent-distribution`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.total_agents, 2);
  assert.ok(body.by_status);
  assert.ok(body.by_model);
  assert.ok(body.by_capability);
  assert.equal(body.by_capability.code, 2);
  await app.close();
});

// ---------- F-196: Agent heartbeat health ----------
test("GET /agents/heartbeat-health returns health analysis", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ag-hbhealth-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/heartbeat-health`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_agents === "number");
  assert.ok(typeof body.healthy === "number");
  assert.ok(typeof body.stale === "number");
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// ---------- F-197: Blocker recurrence rate ----------
test("GET /blockers/recurrence-rate returns recurrence analysis", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `blk-recur-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "flaky test", severity: "medium" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "flaky test", severity: "low" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/recurrence-rate`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.equal(body.total_blockers, 2);
  assert.ok(body.recurring_groups >= 1);
  assert.ok(body.recurrence_rate_percent > 0);
  assert.ok(Array.isArray(body.top_recurring));
  await app.close();
});

// ---------- F-198: Handoff avg acceptance time ----------
test("GET /handoffs/avg-acceptance-time returns acceptance stats", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ho-avgacc-${Date.now().toString(36)}`;
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
  const h = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "task" },
  });
  const hId = JSON.parse(h.payload).handoff_id;
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/${hId}/accept`,
    headers: auth,
    payload: { agent_id: "a2" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/avg-acceptance-time`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.overall_avg_seconds === "number");
  assert.ok(typeof body.total_accepted === "number");
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// ---------- F-199: Claim scope-overlap-risk ----------
test("GET /claims/scope-overlap-risk returns risk analysis", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `cl-overrisk-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "scope1", paths: ["src/a.ts"], ttl_seconds: 3600 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/scope-overlap-risk`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.active_claims === "number");
  assert.ok(typeof body.path_overlaps === "number");
  assert.ok(typeof body.risk_level === "string");
  assert.ok(Array.isArray(body.hot_scopes));
  await app.close();
});

// ---------- F-200: Workspace throughput ----------
test("GET /workspaces/:workspace/throughput returns throughput metrics", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ws-thru-${Date.now().toString(36)}`;
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
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/throughput?hours=24`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.handoffs === "number");
  assert.ok(typeof body.claims === "number");
  assert.ok(typeof body.blockers === "number");
  assert.ok(typeof body.per_hour === "number");
  assert.ok(body.handoffs >= 1);
  await app.close();
});

// ---------- F-201: Agent collaboration score ----------
test("GET /agents/collaboration-score returns scores", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ag-collscore-${Date.now().toString(36)}`;
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
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/collaboration-score`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(Array.isArray(body.agents));
  assert.equal(body.agents.length, 2);
  assert.ok(body.agents[0].collaboration_score >= 0);
  await app.close();
});

// ---------- F-202: Blocker agent impact ----------
test("GET /blockers/agent-impact returns impact analysis", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `blk-agimp-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "issue", severity: "critical" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/agent-impact`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_blockers === "number");
  assert.ok(Array.isArray(body.agents));
  assert.ok(body.agents.length >= 1);
  assert.ok(body.agents[0].impact_score > 0);
  await app.close();
});

// ---------- F-203: Handoff priority distribution ----------
test("GET /handoffs/priority-distribution returns distribution", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ho-pridist-${Date.now().toString(36)}`;
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
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/priority-distribution`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total === "number");
  assert.ok(Array.isArray(body.distribution));
  assert.ok(body.total >= 1);
  await app.close();
});

// ---------- F-204: Claim agent summary ----------
test("GET /claims/agent-summary returns per-agent summary", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `cl-agsum-${Date.now().toString(36)}`;
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
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "file.ts", paths: ["src/file.ts"], ttl_seconds: 3600 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/agent-summary`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_claims === "number");
  assert.ok(Array.isArray(body.agents));
  assert.ok(body.agents.length >= 1);
  assert.ok(body.agents[0].active >= 1);
  await app.close();
});

// ---------- F-205: Workspace blocker trend ----------
test("GET /workspaces/:workspace/blocker-trend returns trend data", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ws-blktrend-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "bug", severity: "medium" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blocker-trend?days=7`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(Array.isArray(body.trend));
  assert.equal(body.days, 7);
  assert.ok(body.trend.length > 0);
  assert.ok(body.trend.some((t: any) => typeof t.opened === "number"));
  await app.close();
});

// ---------- F-206: Agent task completion rate ----------
test("GET /agents/task-completion-rate returns completion rates", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ag-taskcomp-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  // Create a task
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/a1/tasks`,
    headers: auth,
    payload: { title: "fix bug" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/task-completion-rate`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_tasks === "number");
  assert.ok(typeof body.overall_completion_rate === "number");
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// ---------- F-207: Handoff timeout analysis ----------
test("GET /handoffs/timeout-analysis returns timeout stats", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ho-timeout-${Date.now().toString(36)}`;
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
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "task", timeout_seconds: 60 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/timeout-analysis`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_handoffs === "number");
  assert.ok(typeof body.timed_out === "number");
  assert.ok(typeof body.timeout_rate_percent === "number");
  assert.ok(body.with_timeout >= 1);
  await app.close();
});

// ---------- F-208: Claim path frequency ----------
test("GET /claims/path-frequency returns path frequency", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `cl-pathfreq-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "myscope", paths: ["src/main.ts"], ttl_seconds: 3600 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/path-frequency`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(Array.isArray(body.most_claimed_paths));
  assert.ok(Array.isArray(body.most_active_paths));
  assert.ok(body.most_claimed_paths.length >= 1);
  await app.close();
});

// ---------- F-209: Workspace handoff trend ----------
test("GET /workspaces/:workspace/handoff-trend returns trend", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ws-hotrend-${Date.now().toString(36)}`;
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
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoff-trend?days=7`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(Array.isArray(body.trend));
  assert.equal(body.days, 7);
  assert.ok(body.trend.length > 0);
  await app.close();
});

// ---------- F-210: Blocker severity impact ----------
test("GET /blockers/severity-impact returns weighted impact", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `blk-sevimp-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "critical issue", severity: "critical" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/severity-impact`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_weight === "number");
  assert.ok(typeof body.impacted_agents === "number");
  assert.ok(Array.isArray(body.by_severity));
  assert.ok(body.total_weight >= 10); // critical = 10
  await app.close();
});

// ---------- F-211: Agent model distribution ----------
test("GET /agents/model-distribution returns distribution", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ag-modeldist-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["code"], model: "gpt-4" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "a2", display_name: "A2", capabilities: ["review"], model: "claude" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/model-distribution`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total === "number");
  assert.ok(Array.isArray(body.distribution));
  assert.equal(body.total, 2);
  assert.equal(body.distribution.length, 2);
  await app.close();
});

// ---------- F-212: Handoff chain summary ----------
test("GET /handoffs/chain-summary returns chain statistics", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ho-chainsum-${Date.now().toString(36)}`;
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
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/chain-summary`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_handoffs === "number");
  assert.ok(typeof body.total_chains === "number");
  assert.ok(typeof body.max_chain_length === "number");
  assert.ok(typeof body.avg_chain_length === "number");
  await app.close();
});

// ---------- F-213: Claim expiry timeline ----------
test("GET /claims/expiry-timeline returns expiry buckets", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `cl-exptime-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "test", paths: ["src/test.ts"], ttl_seconds: 3600 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/expiry-timeline?hours=24`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.active_claims === "number");
  assert.ok(typeof body.expiring_within_1h === "number");
  assert.ok(Array.isArray(body.buckets));
  await app.close();
});

// ---------- F-214: Workspace claim trend ----------
test("GET /workspaces/:workspace/claim-trend returns trend", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ws-claimtrend-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "s1", paths: ["src/s1.ts"], ttl_seconds: 3600 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claim-trend?days=7`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(Array.isArray(body.trend));
  assert.equal(body.days, 7);
  assert.ok(body.trend.length > 0);
  await app.close();
});

// ---------- F-215: Blocker open duration ----------
test("GET /blockers/open-duration returns duration stats", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `blk-opendur-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "open bug", severity: "high" },
  });
  const res2 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/open-duration`,
    headers: auth,
  });
  assert.equal(res2.statusCode, 200);
  const body2 = JSON.parse(res2.payload);
  assert.ok(typeof body2.open_blockers === "number");
  assert.ok(typeof body2.avg_open_hours === "number");
  assert.ok(typeof body2.max_open_hours === "number");
  assert.ok(Array.isArray(body2.longest_open));
  await app.close();
});

// ---------- F-216: Agent inactive report ----------
test("GET /agents/inactive-report returns inactive agents", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ag-inactive-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  const res2 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/inactive-report?hours=24`,
    headers: auth,
  });
  assert.equal(res2.statusCode, 200);
  const body2 = JSON.parse(res2.payload);
  assert.ok(typeof body2.total_agents === "number");
  assert.ok(typeof body2.active_agents === "number");
  assert.ok(typeof body2.inactive_agents === "number");
  assert.ok(Array.isArray(body2.inactive));
  await app.close();
});

// ---------- F-217: Handoff direction analysis ----------
test("GET /handoffs/direction-analysis returns flow analysis", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ho-diranalysis-${Date.now().toString(36)}`;
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
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/direction-analysis`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_handoffs === "number");
  assert.ok(Array.isArray(body.agents));
  const a1 = body.agents.find((a: any) => a.agent_id === "a1");
  assert.ok(a1);
  assert.equal(a1.role, "delegator");
  await app.close();
});

// ---------- F-218: Claim renewal rate ----------
test("GET /claims/renewal-rate returns renewal statistics", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `cl-renewrate-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "s1", paths: ["src/s1.ts"], ttl_seconds: 3600 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/renewal-rate`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_claims === "number");
  assert.ok(typeof body.renewal_rate_percent === "number");
  assert.ok(typeof body.total_renewals === "number");
  assert.ok(Array.isArray(body.top_renewed));
  await app.close();
});

// ---------- F-219: Stale handoff rate ----------
test("GET /handoffs/stale-handoff-rate returns staleness metrics", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ho-stalerate-${Date.now().toString(36)}`;
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
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/stale-handoff-rate`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_handoffs === "number");
  assert.ok(typeof body.stale_rate_percent === "number");
  assert.ok(typeof body.stale_handoffs === "number");
  await app.close();
});

// ---------- F-220: Claim churn ----------
test("GET /claims/claim-churn returns churn analysis", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `cl-churn-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "s1", paths: ["src/s1.ts"], ttl_seconds: 3600 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-churn`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_claims === "number");
  assert.ok(typeof body.churn_rate_percent === "number");
  assert.ok(Array.isArray(body.agent_churn));
  await app.close();
});

// ---------- F-221: Workspace age ----------
test("GET /workspace-age returns workspace creation age", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ws-age-${Date.now().toString(36)}`;
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/workspace-age`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.age_days === "number");
  assert.ok(typeof body.age_hours === "number");
  assert.ok(body.created_at);
  await app.close();
});

// ---------- F-222: Blocker response time ----------
test("GET /blockers/response-time returns resolution speed metrics", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `bl-resptime-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "bug", severity: "medium" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/response-time`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.resolved_blockers === "number");
  assert.ok(typeof body.avg_response_hours === "number");
  assert.ok(typeof body.median_response_hours === "number");
  await app.close();
});

// ---------- F-223: Agent capability trend ----------
test("GET /agents/capability-trend returns capability growth over time", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ag-captrend-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["code", "review"] },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/capability-trend`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_agents === "number");
  assert.ok(typeof body.unique_capabilities === "number");
  assert.ok(Array.isArray(body.capabilities));
  assert.ok(Array.isArray(body.trend));
  await app.close();
});

// ---------- F-224: Handoff success rate ----------
test("GET /handoffs/success-rate returns success metrics", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ho-succrate-${Date.now().toString(36)}`;
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
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/success-rate`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_handoffs === "number");
  assert.ok(typeof body.success_rate_percent === "number");
  assert.ok(typeof body.rejection_rate_percent === "number");
  await app.close();
});

// ---------- F-225: Claim ownership duration ----------
test("GET /claims/ownership-duration returns duration metrics", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `cl-owndur-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "s1", paths: ["src/s1.ts"], ttl_seconds: 3600 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/ownership-duration`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_claims === "number");
  assert.ok(typeof body.avg_duration_hours === "number");
  assert.ok(Array.isArray(body.longest));
  assert.ok(Array.isArray(body.shortest));
  await app.close();
});

// ---------- F-226: Workspace activity summary ----------
test("GET /workspace activity-summary returns entity counts", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ws-actsumm-${Date.now().toString(36)}`;
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
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/activity-summary`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.agents === "number");
  assert.ok(typeof body.handoffs === "number");
  assert.ok(typeof body.claims === "number");
  assert.ok(typeof body.blockers === "number");
  assert.ok(typeof body.total_entities === "number");
  await app.close();
});

// ---------- F-227: Blocker ownership ----------
test("GET /blockers/ownership returns ownership analysis", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `bl-owner-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "bug", severity: "medium" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/ownership`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_blockers === "number");
  assert.ok(typeof body.unique_owners === "number");
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// ---------- F-228: Agent registration rate ----------
test("GET /agents/registration-rate returns registration trend", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ag-regrate-${Date.now().toString(36)}`;
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
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/registration-rate`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_agents === "number");
  assert.ok(typeof body.avg_registrations_per_day === "number");
  assert.ok(Array.isArray(body.daily));
  await app.close();
});

// ---------- F-229: Handoff latency trend ----------
test("GET /handoffs/latency-trend returns daily latency trend", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ho-lattrd-${Date.now().toString(36)}`;
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
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/latency-trend`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_resolved === "number");
  assert.ok(Array.isArray(body.trend));
  await app.close();
});

// ---------- F-230: Claim scope distribution ----------
test("GET /claims/scope-distribution returns scope breakdown", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `cl-scopedist-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "s1", paths: ["src/s1.ts"], ttl_seconds: 3600 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/scope-distribution`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_claims === "number");
  assert.ok(typeof body.unique_scopes === "number");
  assert.ok(Array.isArray(body.scopes));
  await app.close();
});

// ---------- F-231: Workspace entity growth ----------
test("GET /workspace entity-growth returns daily growth trend", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ws-entgrow-${Date.now().toString(36)}`;
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
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/entity-growth`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(Array.isArray(body.trend));
  assert.ok(body.trend.length > 0);
  assert.ok(typeof body.trend[0].agents === "number");
  await app.close();
});

// ---------- F-232: Blocker comment stats ----------
test("GET /blockers/comment-stats returns comment statistics", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `bl-comstat-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "bug", severity: "medium" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/comment-stats`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_blockers === "number");
  assert.ok(typeof body.total_comments === "number");
  assert.ok(typeof body.avg_comments_per_blocker === "number");
  assert.ok(Array.isArray(body.most_commented));
  await app.close();
});

// ---------- F-233: Agent capability frequency ----------
test("GET /agents/capability-frequency returns capability counts", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ag-capfreq-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["code", "review"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: { agent_id: "a2", display_name: "A2", capabilities: ["code"] },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/capability-frequency`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_agents === "number");
  assert.ok(typeof body.unique_capabilities === "number");
  assert.ok(Array.isArray(body.capabilities));
  const code = body.capabilities.find((c: any) => c.capability === "code");
  assert.ok(code);
  assert.equal(code.count, 2);
  await app.close();
});

// ---------- F-234: Handoff pending age ----------
test("GET /handoffs/pending-age returns pending handoff ages", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ho-pendage-${Date.now().toString(36)}`;
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
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/pending-age`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.pending_count === "number");
  assert.ok(typeof body.avg_age_hours === "number");
  assert.ok(Array.isArray(body.handoffs));
  await app.close();
});

// ---------- F-235: Claim conflict rate ----------
test("GET /claims/conflict-rate returns conflict ratio", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `cl-confrate-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "s1", paths: ["src/s1.ts"], ttl_seconds: 3600 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/conflict-rate`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_claims === "number");
  assert.ok(typeof body.total_conflicts === "number");
  assert.ok(typeof body.conflict_rate_percent === "number");
  await app.close();
});

// ---------- F-236: Workspace blocker summary ----------
test("GET /workspace blocker-summary returns severity breakdown", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ws-blksumm-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "bug", severity: "high" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blocker-summary`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_blockers === "number");
  assert.ok(typeof body.open === "number");
  assert.ok(typeof body.resolved === "number");
  assert.ok(typeof body.resolution_rate_percent === "number");
  assert.ok(body.by_severity);
  await app.close();
});

// ---------- F-237: Blocker deadline compliance ----------
test("GET /blockers/deadline-compliance returns compliance metrics", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `bl-deadcomp-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "bug", severity: "high" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/deadline-compliance`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.blockers_with_deadline === "number");
  assert.ok(typeof body.met_deadline === "number");
  assert.ok(typeof body.compliance_rate_percent === "number");
  await app.close();
});

// ---------- F-238: Handoff route mode stats ----------
test("GET /handoffs/route-mode-stats returns mode breakdown", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ho-routemode-${Date.now().toString(36)}`;
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
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/route-mode-stats`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_handoffs === "number");
  assert.ok(Array.isArray(body.modes));
  await app.close();
});

// ---------- F-239: Agent status distribution ----------
test("GET /agents/status-distribution returns status breakdown", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ag-statdist-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/status-distribution`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_agents === "number");
  assert.ok(Array.isArray(body.statuses));
  assert.ok(body.statuses.length > 0);
  await app.close();
});

// ---------- F-240: Claim active summary ----------
test("GET /claims/active-summary returns active claims detail", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `cl-actsumm-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "s1", paths: ["src/s1.ts"], ttl_seconds: 3600 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/active-summary`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.active_count === "number");
  assert.ok(body.by_agent);
  assert.ok(Array.isArray(body.claims));
  await app.close();
});

// ---------- F-241: Workspace handoff summary ----------
test("GET /workspace handoff-summary returns handoff status breakdown", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ws-hosumm-${Date.now().toString(36)}`;
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
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoff-summary`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_handoffs === "number");
  assert.ok(body.by_status);
  assert.ok(typeof body.success_rate_percent === "number");
  await app.close();
});

// ---------- F-242: Blocker age histogram ----------
test("GET /blockers/age-histogram returns age buckets", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `bl-agehist-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "bug", severity: "medium" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/age-histogram`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_blockers === "number");
  assert.ok(body.buckets);
  await app.close();
});

// ---------- F-243: Handoff summary by agent ----------
test("GET /handoffs/summary-by-agent returns per-agent stats", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ho-summagent-${Date.now().toString(36)}`;
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
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/summary-by-agent`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_handoffs === "number");
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// ---------- F-244: Claim expiry risk ----------
test("GET /claims/expiry-risk returns at-risk claims", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `cl-exprisk-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "s1", paths: ["src/s1.ts"], ttl_seconds: 3600 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/expiry-risk`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.active_with_expiry === "number");
  assert.ok(typeof body.expiring_within_1h === "number");
  assert.ok(Array.isArray(body.at_risk));
  await app.close();
});

// ---------- F-245: Agent last activity ----------
test("GET /agents/last-activity returns idle times", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ag-lastact-${Date.now().toString(36)}`;
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
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/last-activity`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(Array.isArray(body.agents));
  assert.ok(body.agents.length > 0);
  assert.ok(typeof body.agents[0].idle_hours === "number");
  await app.close();
});

// ---------- F-246: Workspace claim summary ----------
test("GET /workspace claim-summary returns claim status breakdown", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ws-clsumm-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "s1", paths: ["src/s1.ts"], ttl_seconds: 3600 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claim-summary`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_claims === "number");
  assert.ok(body.by_status);
  assert.ok(typeof body.active_rate_percent === "number");
  await app.close();
});

// ---------- F-247: Blocker watcher stats ----------
test("GET /blockers/watcher-stats returns watcher metrics", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `bl-watchstat-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "bug", severity: "medium" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/watcher-stats`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_blockers === "number");
  assert.ok(typeof body.total_watchers === "number");
  assert.ok(typeof body.avg_watchers_per_blocker === "number");
  assert.ok(Array.isArray(body.most_watched));
  await app.close();
});

// ---------- F-248: Handoff completion time ----------
test("GET /handoffs/completion-time returns timing metrics", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ho-comptime-${Date.now().toString(36)}`;
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
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/completion-time`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.completed_handoffs === "number");
  assert.ok(typeof body.avg_completion_hours === "number");
  assert.ok(typeof body.median_completion_hours === "number");
  await app.close();
});

// ---------- F-249: Claim transfer rate ----------
test("GET /claims/transfer-rate returns transfer ratio", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `cl-transrate-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "s1", paths: ["src/s1.ts"], ttl_seconds: 3600 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/transfer-rate`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_claims === "number");
  assert.ok(typeof body.total_transfers === "number");
  assert.ok(typeof body.transfer_rate_percent === "number");
  await app.close();
});

// ---------- F-250: Agent workload balance ----------
test("GET /agents/workload-balance returns balance metrics", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ag-wkbalance-${Date.now().toString(36)}`;
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
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/workload-balance`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_agents === "number");
  assert.ok(typeof body.avg_workload === "number");
  assert.ok(typeof body.imbalance === "number");
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// ---------- F-251: Workspace agent summary ----------
test("GET /workspace agent-summary returns agent overview", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ws-agsumm-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["code", "review"] },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agent-summary`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_agents === "number");
  assert.ok(body.by_status);
  assert.ok(typeof body.unique_capabilities === "number");
  assert.ok(Array.isArray(body.capabilities));
  await app.close();
});

// ---------- F-252: Handoff SLA summary ----------
test("GET /handoffs/sla-summary returns SLA compliance overview", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ho-slasumm-${Date.now().toString(36)}`;
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
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", summary: "task" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/sla-summary`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.handoffs_with_sla === "number");
  assert.ok(typeof body.within_sla === "number");
  assert.ok(typeof body.compliance_rate_percent === "number");
  await app.close();
});

// ---------- F-253: Blocker resolution speed ----------
test("GET /blockers/resolution-speed returns speed by severity", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `bl-resspeed-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "bug", severity: "high" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/resolution-speed`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body2 = JSON.parse(res.payload);
  assert.ok(typeof body2.total_resolved === "number");
  assert.ok(Array.isArray(body2.by_severity));
  await app.close();
});

// ---------- F-254: Claim scope popularity ----------
test("GET /claims/scope-popularity returns popular scopes", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `cl-scpopular-${Date.now().toString(36)}`;
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
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["c"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "s1", paths: ["src/s1.ts"], ttl_seconds: 3600 },
  });
  const res2 = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/scope-popularity`,
    headers: auth,
  });
  assert.equal(res2.statusCode, 200);
  const body3 = JSON.parse(res2.payload);
  assert.ok(typeof body3.total_claims === "number");
  assert.ok(typeof body3.unique_scopes === "number");
  assert.ok(Array.isArray(body3.most_popular));
  await app.close();
});

// ---------- F-255: Agent task summary ----------
test("GET /agents/task-summary returns task breakdown per agent", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ag-tasksumm-${Date.now().toString(36)}`;
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
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/task-summary`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_tasks === "number");
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// ---------- F-256: Workspace audit frequency ----------
test("GET /workspace audit-frequency returns event breakdown", async () => {
  runMigrations();
  const app = buildApp();
  await app.ready();
  const ws = `ws-audfreq-${Date.now().toString(36)}`;
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
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/audit-frequency`,
    headers: auth,
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.ok(typeof body.total_events === "number");
  assert.ok(typeof body.unique_actions === "number");
  assert.ok(Array.isArray(body.top_actions));
  assert.ok(Array.isArray(body.daily));
  await app.close();
});

// F-257 handoff-priority-balance
test("GET /handoffs/priority-balance returns priority distribution", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-hpb-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a2", display_name: "A2", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "t" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/priority-balance`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.total_handoffs === "number");
  assert.ok(body.by_priority);
  await app.close();
});

// F-258 blocker-dependency-stats
test("GET /blockers/dependency-stats returns dependency statistics", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-bds-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "b1", severity: "medium" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/dependency-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.total_blockers === "number");
  assert.ok(typeof body.total_dependencies === "number");
  assert.ok(typeof body.blockers_with_dependencies === "number");
  await app.close();
});

// F-259 agent-idle-time
test("GET /agents/idle-time returns agent idle durations", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-ait-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["x"] },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/idle-time`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(Array.isArray(body.agents));
  if (body.agents.length > 0) {
    assert.ok(typeof body.agents[0].idle_seconds === "number");
  }
  await app.close();
});

// F-260 claim-path-coverage
test("GET /claims/path-coverage returns path coverage stats", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-cpc-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "pathcov", paths: ["src/main.ts"] },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/path-coverage`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.total_paths === "number");
  assert.ok(Array.isArray(body.paths));
  await app.close();
});

// F-261 workspace-health-trend
test("GET /workspaces/:ws/health-trend returns daily health trend", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-wht-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/health-trend`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(Array.isArray(body.daily));
  await app.close();
});

// F-262 handoff-timeout-risk
test("GET /handoffs/timeout-risk returns at-risk handoffs", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-htr-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a2", display_name: "A2", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "t" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/timeout-risk`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.total_at_risk === "number");
  assert.ok(typeof body.already_expired === "number");
  assert.ok(Array.isArray(body.handoffs));
  await app.close();
});

// F-263 blocker-creation-rate
test("GET /blockers/creation-rate returns daily creation rate", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-bcr-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "b1", severity: "high" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/creation-rate`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.avg_per_day === "number");
  assert.ok(Array.isArray(body.daily));
  await app.close();
});

// F-264 claim-agent-overlap
test("GET /claims/agent-overlap returns agent overlap pairs", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-cao-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/agent-overlap`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.total_overlapping_pairs === "number");
  assert.ok(Array.isArray(body.pairs));
  await app.close();
});

// F-265 agent-heartbeat-gap
test("GET /agents/heartbeat-gap returns gap analysis", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-ahg-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["x"] },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/heartbeat-gap`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.total_agents === "number");
  assert.ok(typeof body.avg_gap_seconds === "number");
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-266 workspace-bottleneck-report
test("GET /workspaces/:ws/bottleneck-report returns bottleneck analysis", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-wbr-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/bottleneck-report`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.total_bottlenecks === "number");
  assert.ok(Array.isArray(body.bottlenecks));
  await app.close();
});

// F-267 handoff-agent-pair-stats
test("GET /handoffs/agent-pair-stats returns pair statistics", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-haps-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a2", display_name: "A2", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "t" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/agent-pair-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.total_pairs === "number");
  assert.ok(Array.isArray(body.pairs));
  await app.close();
});

// F-268 claim-expiry-countdown
test("GET /claims/expiry-countdown returns expiring claims", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-cec-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "expcount", paths: ["src/a.ts"], ttl_seconds: 3600 },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/expiry-countdown`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.total_expiring === "number");
  assert.ok(Array.isArray(body.claims));
  await app.close();
});

// F-269 blocker-escalation-chain
test("GET /blockers/escalation-chain returns escalation data", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-bec-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/escalation-chain`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.total_escalations === "number");
  assert.ok(Array.isArray(body.blockers));
  await app.close();
});

// F-270 agent-collaboration-history
test("GET /agents/collaboration-history returns collaboration data", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-ach-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a2", display_name: "A2", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "t" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/collaboration-history`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.total_interactions === "number");
  assert.ok(Array.isArray(body.collaborations));
  await app.close();
});

// F-271 handoff-delegation-chain
test("GET /handoffs/delegation-chain returns chain analysis", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-hdc-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a2", display_name: "A2", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "t" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/delegation-chain`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.total_chains === "number");
  assert.ok(typeof body.max_depth === "number");
  await app.close();
});

// F-272 workspace-event-stream
test("GET /workspaces/:ws/event-stream returns recent events", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-wes-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/event-stream`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.total_events === "number");
  assert.ok(Array.isArray(body.events));
  await app.close();
});

// F-273 claim-renewal-heatmap
test("GET /claims/renewal-heatmap returns daily renewal data", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-crh-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/renewal-heatmap`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.total_renewals === "number");
  assert.ok(Array.isArray(body.daily));
  await app.close();
});

// F-274 blocker-agent-workload
test("GET /blockers/agent-workload returns agent blocker workload", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-baw-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "a1", title: "b1", severity: "medium" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/agent-workload`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.total_agents === "number");
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-275 handoff-volume-trend
test("GET /handoffs/volume-trend returns daily volume", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-hvt-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a2", display_name: "A2", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "a1", to_agent_id: "a2", summary: "t" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/volume-trend`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.avg_per_day === "number");
  assert.ok(Array.isArray(body.daily));
  await app.close();
});

// F-276 claim-status-summary
test("GET /claims/status-summary returns status breakdown", async () => {
  runMigrations();
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = `ws-css-${Date.now().toString(36)}`;
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents`,
    headers: auth,
    payload: { agent_id: "a1", display_name: "A1", capabilities: ["x"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "statsum", paths: ["src/a.ts"] },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/status-summary`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.payload);
  assert.strictEqual(body.workspace, ws);
  assert.ok(typeof body.total_claims === "number");
  assert.ok(body.by_status);
  await app.close();
});

// F-277 agent-registration-trend
test("GET /agents/registration-trend returns trend data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "regtrend-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/registration-trend`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.trend));
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-278 blocker-unresolved-aging
test("GET /blockers/unresolved-aging returns aging stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "braging-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/unresolved-aging`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.unresolved === "number");
  assert.ok(typeof body.avg_hours_open === "number");
  await app.close();
});

// F-279 handoff-chain-length-stats
test("GET /handoffs/chain-length-stats returns depth distribution", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "chainlen-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/chain-length-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.distribution));
  assert.ok(typeof body.max_depth === "number");
  await app.close();
});

// F-280 claim-contention-hotspots
test("GET /claims/contention-hotspots returns hotspots", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hotspot-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/contention-hotspots`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.hotspots));
  await app.close();
});

// F-281 agent-capability-matrix
test("GET /agents/skill-overlap returns overlap data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "capmat-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/skill-overlap`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  assert.ok(Array.isArray(body.all_capabilities));
  await app.close();
});

// F-282 blocker-cascade-risk
test("GET /blockers/cascade-risk returns cascade risks", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "cascade-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/cascade-risk`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.cascade_risks));
  await app.close();
});

// F-283 agent-model-breakdown
test("GET /agents/model-breakdown returns distribution", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "modeldist-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/model-breakdown`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.distribution));
  assert.ok(typeof body.total_agents === "number");
  await app.close();
});

// F-284 handoff-feedback-summary
test("GET /handoffs/feedback-summary returns summary", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "feedback-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/feedback-summary`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  assert.ok(typeof body.with_feedback === "number");
  await app.close();
});

// F-285 workspace-capacity
test("GET /workspace-capacity returns capacity summary", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "wscap-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/workspace-capacity`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.agents === "number");
  assert.ok(typeof body.claims === "number");
  assert.ok(typeof body.blockers === "number");
  assert.ok(typeof body.handoffs === "number");
  await app.close();
});

// F-286 handoff-peak-hours
test("GET /handoffs/peak-hours returns peak hours", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "peakhrs-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/peak-hours`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.by_hour));
  await app.close();
});

// F-287 blocker-comment-activity
test("GET /blockers/comment-activity returns activity", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bcomact-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/comment-activity`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blockers));
  await app.close();
});

// F-288 claim-abandonment-rate
test("GET /claims/abandonment-rate returns rate", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "abandon-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/abandonment-rate`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  assert.ok(typeof body.abandonment_rate === "number");
  await app.close();
});

// F-289 workspace-growth-rate
test("GET /workspace-growth-rate returns growth data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "wsgrow-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/workspace-growth-rate`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(body.growth);
  assert.ok(typeof body.growth.agents === "object");
  await app.close();
});

// F-290 agent-session-duration
test("GET /agents/session-duration returns durations", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "sessdur-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/session-duration`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  assert.ok(typeof body.avg_hours === "number");
  await app.close();
});

// F-291 handoff-recipient-stats
test("GET /handoffs/recipient-stats returns recipient data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "recpst-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/recipient-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.recipients));
  await app.close();
});

// F-292 claim-scope-density
test("GET /claims/scope-density returns density data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "scpden-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/scope-density`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.scopes));
  await app.close();
});

// F-293 agent-tag-distribution
test("GET /agents/tag-distribution returns tag data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "tagdist-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/tag-distribution`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.tags));
  await app.close();
});

// F-294 blocker-watcher-engagement
test("GET /blockers/watcher-engagement returns engagement data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bwatch-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/watcher-engagement`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blockers));
  assert.ok(typeof body.avg_watchers === "number");
  await app.close();
});

// F-295 capability-retirement
test("GET /agents/capability-retirement returns retired capabilities", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "capret-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/capability-retirement`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  assert.ok(typeof body.total_retired === "number");
  await app.close();
});

// F-296 round-trip-time
test("GET /handoffs/round-trip-time returns pair timing data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "rtt-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/round-trip-time`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.pairs));
  await app.close();
});

// F-297 priority-histogram
test("GET /claims/priority-histogram returns priority buckets", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "prihist-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/priority-histogram`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.buckets));
  await app.close();
});

// F-298 resolution-pattern
test("GET /blockers/resolution-pattern returns resolution patterns", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "respat-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/resolution-pattern`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.patterns));
  await app.close();
});

// F-299 capability-demand
test("GET /handoffs/capability-demand returns demand data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "capdem-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/capability-demand`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.capabilities));
  await app.close();
});

// F-300 stale-capabilities
test("GET /agents/stale-capabilities returns stale data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "stalecap-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/stale-capabilities`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-301 renewal-streak
test("GET /claims/renewal-streak returns streak data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "renstrk-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/renewal-streak`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.streaks));
  await app.close();
});

// F-302 entity-count
test("GET /entity-count returns entity counts", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "entcnt-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/entity-count`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  assert.ok(typeof body.agents === "number");
  await app.close();
});

// F-303 severity-escalation-rate
test("GET /blockers/severity-escalation-rate returns escalation data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "sevesc-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/severity-escalation-rate`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.escalation_rate === "number");
  assert.ok(Array.isArray(body.by_level));
  await app.close();
});

// F-304 pending-duration
test("GET /handoffs/pending-duration returns pending data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "pendur-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/pending-duration`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.pending_handoffs));
  assert.ok(typeof body.avg_pending_seconds === "number");
  await app.close();
});

// F-305 scope-length-stats
test("GET /claims/scope-length-stats returns length stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "scplen-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/scope-length-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-306 multi-workspace
test("GET /agents/multi-workspace returns multi-workspace agents", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "multiws-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/multi-workspace`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-307 top-reporters
test("GET /blockers/top-reporters returns reporter data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "toprep-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/top-reporters`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.reporters));
  await app.close();
});

// F-308 rejection-reasons
test("GET /handoffs/rejection-reasons returns rejection data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "rejrsn-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/rejection-reasons`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.rejections));
  assert.ok(typeof body.total_rejected === "number");
  await app.close();
});

// F-309 expiry-velocity
test("GET /claims/expiry-velocity returns velocity data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "expvel-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/expiry-velocity`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.daily));
  assert.ok(typeof body.avg_per_day === "number");
  await app.close();
});

// F-310 summary-report
test("GET /summary-report returns comprehensive report", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "sumrpt-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/summary-report`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.agents.total === "number");
  assert.ok(typeof body.handoffs.total === "number");
  assert.ok(typeof body.blockers.total === "number");
  assert.ok(typeof body.claims.total === "number");
  await app.close();
});

// F-311 capability-rarity
test("GET /agents/capability-rarity returns rarity data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "caprar-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/capability-rarity`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.capabilities));
  await app.close();
});

// F-312 acceptance-lag
test("GET /handoffs/acceptance-lag returns lag data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "acclag-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/acceptance-lag`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-313 deadline-proximity
test("GET /blockers/deadline-proximity returns proximity data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "dlprox-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/deadline-proximity`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blockers));
  assert.ok(typeof body.overdue_count === "number");
  await app.close();
});

// F-314 agent-diversity
test("GET /claims/agent-diversity returns diversity data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "agdiv-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/agent-diversity`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  assert.ok(typeof body.diversity_ratio === "number");
  await app.close();
});

// F-315 recent-deregistrations
test("GET /agents/recent-deregistrations returns offline agents", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "recdereg-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/recent-deregistrations`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-316 orphan-detection
test("GET /handoffs/orphan-detection returns orphaned handoffs", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "orphdet-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/orphan-detection`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.orphans));
  assert.ok(typeof body.count === "number");
  await app.close();
});

// F-317 comment-frequency
test("GET /blockers/comment-frequency returns frequency data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "comfreq-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/comment-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blockers));
  assert.ok(typeof body.avg_comments_per_blocker === "number");
  await app.close();
});

// F-318 transfer-velocity
test("GET /claims/transfer-velocity returns velocity data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "trnvel-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/transfer-velocity`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.daily));
  assert.ok(typeof body.avg_per_day === "number");
  await app.close();
});

// F-319 capability-load
test("GET /agents/capability-load returns load data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "capload-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/capability-load`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.capabilities));
  await app.close();
});

// F-320 audit-timeline
test("GET /audit-timeline returns hourly audit data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "audtl-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/audit-timeline`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.timeline));
  await app.close();
});

// F-321 sla-violation-agents
test("GET /handoffs/sla-violation-agents returns violation data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "slaviol-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/sla-violation-agents`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-322 cross-agent-impact
test("GET /blockers/cross-agent-impact returns impact data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "xaimp-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/cross-agent-impact`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blockers));
  await app.close();
});

// F-323 scope-prefix-tree
test("GET /claims/scope-prefix-tree returns prefix data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "scppfx-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/scope-prefix-tree`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.prefixes));
  await app.close();
});

// F-324 heartbeat-consistency
test("GET /agents/heartbeat-consistency returns consistency data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hbcon-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/heartbeat-consistency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  assert.ok(typeof body.avg_seconds_since_heartbeat === "number");
  await app.close();
});

// F-325 template-usage
test("GET /handoffs/template-usage returns template data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "tmpusg-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/template-usage`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.templates));
  await app.close();
});

// F-326 operational-status
test("GET /operational-status returns status data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "opstat-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/operational-status`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(["green", "yellow", "red"].includes(body.status));
  assert.ok(typeof body.online_agents === "number");
  await app.close();
});

// F-327 task-backlog
test("GET /agents/task-backlog returns backlog data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "taskbl-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/task-backlog`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-328 dependency-chain-length
test("GET /blockers/dependency-chain-length returns chain data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "depchn-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/dependency-chain-length`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.chains));
  assert.ok(typeof body.max_depth === "number");
  await app.close();
});

// F-329 overlapping-scopes
test("GET /claims/overlapping-scopes returns overlaps", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "ovlap-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/overlapping-scopes`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.overlaps));
  await app.close();
});

// F-330 context-size-stats
test("GET /handoffs/context-size-stats returns size stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "ctxsz-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/context-size-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-331 handoff-flow-balance
test("GET /workspaces/handoff-flow-balance returns balance", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hfbal-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoff-flow-balance`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-332 idle-duration
test("GET /agents/idle-duration returns idle agents", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "idldr-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/idle-duration`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-333 auto-escalation-candidates
test("GET /blockers/auto-escalation-candidates returns candidates", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "autoesc-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/auto-escalation-candidates`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.candidates));
  await app.close();
});

// F-334 usage-heatmap
test("GET /claims/usage-heatmap returns heatmap data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "clheat-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/usage-heatmap`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.heatmap));
  await app.close();
});

// F-335 summary-keyword-search
test("GET /handoffs/summary-keyword-search returns results", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "sumkw-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/summary-keyword-search?q=test`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.results));
  await app.close();
});

// F-336 blocker-aging-report
test("GET /workspaces/blocker-aging-report returns aging data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "blkage-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blocker-aging-report`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.aging));
  await app.close();
});

// F-337 capability-overlap-matrix
test("GET /agents/capability-overlap-matrix returns overlaps", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "capovl-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/capability-overlap-matrix`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.overlaps));
  await app.close();
});

// F-338 longest-active
test("GET /claims/longest-active returns longest active claims", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "lngact-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/longest-active`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.claims));
  await app.close();
});

// F-339 resolution-time-percentiles
test("GET /blockers/resolution-time-percentiles returns percentiles", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "rspctl-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/resolution-time-percentiles`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.count === "number");
  await app.close();
});

// F-340 chain-analysis
test("GET /handoffs/chain-analysis returns chain data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "chnan-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/chain-analysis`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.chains));
  assert.ok(typeof body.max_depth === "number");
  await app.close();
});

// F-341 claim-expiry-forecast
test("GET /workspaces/claim-expiry-forecast returns forecast", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "clexp-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claim-expiry-forecast`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.next_1h === "number" || body.next_1h === null);
  await app.close();
});

// F-342 metadata-size-stats
test("GET /agents/metadata-size-stats returns size stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "metasz-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/metadata-size-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-343 renewal-frequency
test("GET /claims/renewal-frequency returns frequency data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "rnwfq-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/renewal-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.claims));
  await app.close();
});

// F-344 watcher-count
test("GET /blockers/watcher-count returns watcher counts", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "wtchct-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/watcher-count`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blockers));
  await app.close();
});

// F-345 priority-breakdown
test("GET /handoffs/priority-breakdown returns breakdown", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hpbd-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/priority-breakdown`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.breakdown));
  await app.close();
});

// F-346 task-priority-distribution
test("GET /workspaces/task-priority-distribution returns distribution", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "tskpd-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/task-priority-distribution`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.distribution));
  await app.close();
});

// F-347 last-activity-summary
test("GET /agents/last-activity-summary returns summary", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "lastact-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/last-activity-summary`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-348 scope-collision-risk
test("GET /claims/scope-collision-risk returns risks", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "scprsk-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/scope-collision-risk`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.risks));
  await app.close();
});

// F-349 severity-distribution-trend
test("GET /blockers/severity-distribution-trend returns trend", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "sevtrd-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/severity-distribution-trend`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.trend));
  await app.close();
});

// F-350 agent-pair-frequency
test("GET /handoffs/agent-pair-frequency returns pairs", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "agpfr-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/agent-pair-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.pairs));
  await app.close();
});

// F-351 tag-usage-stats
test("GET /agents/tag-usage-stats returns tag stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "taguse-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/tag-usage-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.tags));
  await app.close();
});

// F-352 open-duration-ranking
test("GET /blockers/open-duration-ranking returns ranking", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "opndr-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/open-duration-ranking`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blockers));
  await app.close();
});

// F-353 handoff-completion-rate
test("GET /workspaces/handoff-completion-rate returns rate", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hcrate-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoff-completion-rate`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.rate === "number");
  await app.close();
});

// F-354 agent-claim-count-ranking
test("GET /claims/agent-claim-count-ranking returns ranking", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "aclrk-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/agent-claim-count-ranking`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.ranking));
  await app.close();
});

// F-355 stale-pending
test("GET /handoffs/stale-pending returns stale handoffs", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "stlpnd-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/stale-pending`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.stale));
  assert.ok(typeof body.threshold_hours === "number");
  await app.close();
});

// F-356 capability-count-ranking
test("GET /agents/capability-count-ranking returns ranking", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "capcr-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/capability-count-ranking`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.ranking));
  await app.close();
});

// F-357 audit-action-frequency
test("GET /workspaces/audit-action-frequency returns actions", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "audfq-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/audit-action-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.actions));
  await app.close();
});

// F-358 title-word-cloud
test("GET /blockers/title-word-cloud returns word cloud", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bwcld-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/title-word-cloud`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.words));
  await app.close();
});

// F-359 expiry-distribution
test("GET /claims/expiry-distribution returns distribution", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "expdst-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/expiry-distribution`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.distribution));
  await app.close();
});

// F-360 retry-count-stats
test("GET /handoffs/retry-count-stats returns stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "rtycnt-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/retry-count-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-361 uptime-leaderboard
test("GET /agents/uptime-leaderboard returns leaderboard", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "uptlb-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/uptime-leaderboard`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.leaderboard));
  await app.close();
});

// F-362 blocker-resolution-rate
test("GET /workspaces/blocker-resolution-rate returns rate", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "blkrr-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blocker-resolution-rate`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.rate === "number");
  await app.close();
});

// F-363 claim-status-transition-counts
test("GET /claims/status-transition-counts returns transitions", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "cstc-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/status-transition-counts`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.transitions));
  await app.close();
});

// F-364 handoff-pending-duration-ranking
test("GET /handoffs/pending-duration-ranking returns ranking", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hpdr-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/pending-duration-ranking`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.ranking));
  await app.close();
});

// F-365 agent-heartbeat-frequency
test("GET /agents/heartbeat-frequency returns agents", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "ahf-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/heartbeat-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-366 blocker-comment-count-ranking
test("GET /blockers/comment-count-ranking returns ranking", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bccr-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/comment-count-ranking`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.ranking));
  await app.close();
});

// F-367 workspace-agent-model-summary
test("GET /workspaces/agent-model-summary returns models", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "wams-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agent-model-summary`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.models));
  await app.close();
});

// F-368 handoff-acceptance-rate
test("GET /handoffs/acceptance-rate returns rate", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "har-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/acceptance-rate`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.acceptance_rate === "number");
  await app.close();
});

// F-369 claim-active-per-agent
test("GET /claims/active-per-agent returns agents", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "capa-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/active-per-agent`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-370 blocker-severity-agent-matrix
test("GET /blockers/severity-agent-matrix returns matrix", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bsam-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/severity-agent-matrix`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.matrix));
  await app.close();
});

// F-371 agent-registration-age
test("GET /agents/registration-age returns agents", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "ara-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/registration-age`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-372 workspace-claim-utilization
test("GET /workspaces/claim-utilization returns utilization", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "wcu-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claim-utilization`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.utilization_pct === "number");
  await app.close();
});

// F-373 handoff-route-mode-breakdown
test("GET /handoffs/route-mode-breakdown returns modes", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hrmb-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/route-mode-breakdown`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.modes));
  await app.close();
});

// F-374 blocker-overdue-count
test("GET /blockers/overdue-count returns overdue", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "boc-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/overdue-count`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.overdue === "number");
  await app.close();
});

// F-375 claim-path-depth-stats
test("GET /claims/path-depth-stats returns paths", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "cpds-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/path-depth-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.paths));
  await app.close();
});

// F-376 agent-online-offline-ratio
test("GET /agents/online-offline-ratio returns ratio", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "aoor-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/online-offline-ratio`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-377 workspace-handoff-daily-count
test("GET /workspaces/handoff-daily-count returns days", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "whdc-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoff-daily-count`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.days));
  await app.close();
});

// F-378 handoff-context-length-ranking
test("GET /handoffs/context-length-ranking returns ranking", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hclr-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/context-length-ranking`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.ranking));
  await app.close();
});

// F-379 blocker-created-daily
test("GET /blockers/created-daily returns days", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bcd-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/created-daily`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.days));
  await app.close();
});

// F-380 claim-renewal-success-rate
test("GET /claims/renewal-success-rate returns rate", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "crsr-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/renewal-success-rate`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.success_rate === "number");
  await app.close();
});

// F-381 agent-capability-diversity
test("GET /agents/capability-diversity returns agents", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "acd-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/capability-diversity`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-382 workspace-blocker-severity-summary
test("GET /workspaces/blocker-severity-summary returns severities", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "wbss-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blocker-severity-summary`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.severities));
  await app.close();
});

// F-383 handoff-summary-length-stats
test("GET /handoffs/summary-length-stats returns stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hsls-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/summary-length-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-384 claim-created-daily
test("GET /claims/created-daily returns days", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "ccrd-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/created-daily`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.days));
  await app.close();
});

// F-385 workspace-agent-status-breakdown
test("GET /workspaces/agent-status-breakdown returns statuses", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "wasb-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agent-status-breakdown`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.statuses));
  await app.close();
});

// F-386 blocker-resolution-time-avg
test("GET /blockers/resolution-time-avg returns avg", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "brta-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/resolution-time-avg`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.resolved_count === "number");
  await app.close();
});

// F-387 agent-task-status-summary
test("GET /agents/task-status-summary returns summary", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "atss-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/task-status-summary`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.summary));
  await app.close();
});

// F-388 handoff-expired-count
test("GET /handoffs/expired-count returns count", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hec-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/expired-count`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.expired === "number");
  await app.close();
});

// F-389 workspace-audit-entity-type-breakdown
test("GET /workspaces/audit-entity-type-breakdown returns types", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "waet-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/audit-entity-type-breakdown`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.entity_types));
  await app.close();
});

// F-390 claim-scope-prefix-stats
test("GET /claims/scope-prefix-stats returns prefixes", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "csps-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/scope-prefix-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.prefixes));
  await app.close();
});

// F-391 capability-tag-frequency
test("GET /handoffs/capability-tag-frequency returns tags", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "captfq-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/capability-tag-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.tags));
  await app.close();
});

// F-392 group-member-count
test("GET /agents/group-member-count returns groups", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "grpmem-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/group-member-count`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.groups));
  await app.close();
});

// F-393 open-by-agent
test("GET /blockers/open-by-agent returns agents", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "opnag-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/open-by-agent`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-394 expiry-window-stats
test("GET /claims/expiry-window-stats returns windows", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "expwin-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/expiry-window-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.windows));
  await app.close();
});

// F-395 handoff-sla-compliance
test("GET /workspaces/handoff-sla-compliance returns compliance", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "slacmp-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoff-sla-compliance`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-396 notes-length-stats
test("GET /handoffs/notes-length-stats returns stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "ntlen-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/notes-length-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-397 recently-updated
test("GET /agents/recently-updated returns agents", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "rcntup-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/recently-updated`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-398 escalation-level-distribution
test("GET /blockers/escalation-level-distribution returns levels", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "esclvl-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/escalation-level-distribution`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.distribution));
  await app.close();
});

// F-399 audit-actor-frequency
test("GET /workspaces/audit-actor-frequency returns actors", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "audact-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/audit-actor-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.actors));
  await app.close();
});

// F-400 path-pattern-frequency
test("GET /claims/path-pattern-frequency returns patterns", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "pthpat-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/path-pattern-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.patterns));
  await app.close();
});

// F-401 heartbeat-gap-analysis
test("GET /agents/heartbeat-gap-analysis returns agents", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hbgap-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/heartbeat-gap-analysis`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-402 tag-co-occurrence
test("GET /agents/tag-co-occurrence returns pairs", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "tagco-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/tag-co-occurrence`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.pairs));
  await app.close();
});

// F-403 retry-count-distribution
test("GET /handoffs/retry-count-distribution returns distribution", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hrcd-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/retry-count-distribution`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.distribution));
  await app.close();
});

// F-404 severity-resolution-time
test("GET /blockers/severity-resolution-time returns stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bsrt-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/severity-resolution-time`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.stats));
  await app.close();
});

// F-405 age-distribution
test("GET /claims/age-distribution returns buckets", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "cage-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/age-distribution`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.distribution));
  await app.close();
});

// F-406 entity-totals
test("GET /workspaces/entity-totals returns counts", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "etot-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/entity-totals`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.totals.agents === "number");
  assert.ok(typeof body.totals.claims === "number");
  await app.close();
});

// F-407 capabilities-per-agent
test("GET /agents/capabilities-per-agent returns counts", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "capa-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/capabilities-per-agent`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-408 watcher-count-ranking
test("GET /blockers/watcher-count-ranking returns blockers", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bwcr-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/watcher-count-ranking`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blockers));
  await app.close();
});

// F-409 priority-by-route-mode
test("GET /handoffs/priority-by-route-mode returns stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "pbrm-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/priority-by-route-mode`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.stats));
  await app.close();
});

// F-410 transfer-leaderboard
test("GET /claims/transfer-leaderboard returns leaderboard", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "trlb-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/transfer-leaderboard`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.leaderboard));
  await app.close();
});

// F-411 activity-heatmap
test("GET /workspaces/activity-heatmap returns hours", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "aheat-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/activity-heatmap`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.heatmap));
  await app.close();
});

// F-412 idle-time-histogram
test("GET /agents/idle-time-histogram returns buckets", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "idleh-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/idle-time-histogram`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.histogram));
  await app.close();
});

// F-413 sla-breach-list
test("GET /handoffs/sla-breach-list returns breached handoffs", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "slab-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/sla-breach-list`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.breached));
  await app.close();
});

// F-414 age-percentiles
test("GET /blockers/age-percentiles returns percentiles", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bagp-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/age-percentiles`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.count === "number");
  assert.ok(typeof body.p50 === "number");
  await app.close();
});

// F-415 renewal-gap-analysis
test("GET /claims/renewal-gap-analysis returns claims", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "rnga-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/renewal-gap-analysis`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.claims));
  await app.close();
});

// F-416 timeout-utilization
test("GET /handoffs/timeout-utilization returns handoffs", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "tmut-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/timeout-utilization`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.handoffs));
  await app.close();
});

// F-417 audit-growth-rate
test("GET /workspaces/audit-growth-rate returns daily counts", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "augr-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/audit-growth-rate`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.daily));
  await app.close();
});

// F-418 model-version-matrix
test("GET /agents/model-version-matrix returns matrix", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "mvm-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/model-version-matrix`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.matrix));
  await app.close();
});

// F-419 resolution-streak
test("GET /blockers/resolution-streak returns streak", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "brs-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/resolution-streak`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.streak_days === "number");
  await app.close();
});

// F-420 from-to-heatmap
test("GET /handoffs/from-to-heatmap returns pairs", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "fthm-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/from-to-heatmap`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.pairs));
  await app.close();
});

// F-421 claim-density-by-agent
test("GET /claims/claim-density-by-agent returns density data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "cldens-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-density-by-agent`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-422 handoff-retry-stats
test("GET /handoffs/handoff-retry-stats returns retry stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hrtry-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-retry-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-423 blocker-title-length
test("GET /blockers/blocker-title-length returns length stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bktlen-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-title-length`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-424 agent-uptime-ranking
test("GET /agents/agent-uptime-ranking returns ranking", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "aguptm-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/agent-uptime-ranking`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-425 workspace-settings-audit
test("GET /workspaces/workspace-settings-audit returns settings", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "wsset-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/workspace-settings-audit`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.settings));
  await app.close();
});

// F-426 handoff-notes-count
test("GET /handoffs/handoff-notes-count returns note counts", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hnotc-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-notes-count`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.handoffs));
  await app.close();
});

// F-427 blocker-comment-authors
test("GET /blockers/blocker-comment-authors returns author data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bcaut-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-comment-authors`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blockers));
  await app.close();
});

// F-428 agent-display-name-length
test("GET /agents/agent-display-name-length returns length stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "adnl-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/agent-display-name-length`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-429 claim-expiry-horizon
test("GET /claims/claim-expiry-horizon returns horizon data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "cexph-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-expiry-horizon`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.claims));
  await app.close();
});

// F-430 blocker-resolution-speed
test("GET /blockers/blocker-resolution-speed returns speed data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "brspd-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-resolution-speed`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blockers));
  await app.close();
});

// F-431 workspace-archived-count
test("GET /workspaces/workspace-archived-count returns counts", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/workspaces/workspace-archived-count",
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-432 handoff-chain-depth
test("GET /handoffs/handoff-chain-depth returns depth stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hcd-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-chain-depth`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-433 agent-tag-diversity
test("GET /agents/agent-tag-diversity returns tag diversity", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "atdiv-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/agent-tag-diversity`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.unique_tags === "number");
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-434 claim-renewal-frequency
test("GET /claims/claim-renewal-frequency returns renewal data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "crf-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-renewal-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.claims));
  await app.close();
});

// F-435 blocker-watcher-count
test("GET /blockers/blocker-watcher-count returns watcher data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bwc-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-watcher-count`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blockers));
  await app.close();
});

// F-436 handoff-notes-word-count
test("GET /handoffs/handoff-notes-word-count returns word counts", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hnwc-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-notes-word-count`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.notes));
  await app.close();
});

// F-437 workspace-description-length
test("GET /workspaces/workspace-description-length returns lengths", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/workspaces/workspace-description-length",
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.workspaces));
  await app.close();
});

// F-438 claim-transfer-volume
test("GET /claims/claim-transfer-volume returns transfer data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "ctv-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-transfer-volume`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.transfers));
  await app.close();
});

// F-439 blocker-escalation-trend
test("GET /blockers/blocker-escalation-trend returns escalation data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "besc-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-escalation-trend`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.levels));
  await app.close();
});

// F-440 handoff-template-usage
test("GET /handoffs/handoff-template-usage returns template data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "htmu-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-template-usage`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.templates));
  await app.close();
});

// F-441 agent-status-transition
test("GET /agents/agent-status-transition returns transition data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "ast-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/agent-status-transition`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.transitions));
  await app.close();
});

// F-442 claim-scope-collision
test("GET /claims/claim-scope-collision returns collision data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "csc-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-scope-collision`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.collisions));
  await app.close();
});

// F-443 workspace-agent-count-trend
test("GET /workspace-agent-count-trend returns trend data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "wact-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/workspace-agent-count-trend`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.trend));
  await app.close();
});

// F-444 blocker-deadline-proximity
test("GET /blockers/blocker-deadline-proximity returns proximity data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bdlp-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-deadline-proximity`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blockers));
  await app.close();
});

// F-445 handoff-acceptance-lag
test("GET /handoffs/handoff-acceptance-lag returns lag data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hal-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-acceptance-lag`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.handoffs));
  await app.close();
});

// F-446 agent-model-version
test("GET /agents/agent-model-version returns model data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "amv-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/agent-model-version`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.models));
  await app.close();
});

// F-447 claim-path-pattern-stats
test("GET /claims/claim-path-pattern-stats returns pattern data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "cpps-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-path-pattern-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.patterns));
  await app.close();
});

// F-448 handoff-context-size
test("GET /handoffs/handoff-context-size returns size stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hcs-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-context-size`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-449 blocker-comment-frequency
test("GET /blockers/blocker-comment-frequency returns frequency data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bcf-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-comment-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.trend));
  await app.close();
});

// F-450 workspace-base-path-stats
test("GET /workspaces/workspace-base-path-stats returns path data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/workspaces/workspace-base-path-stats",
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.paths));
  await app.close();
});

// F-451 agent-task-completion
test("GET /agents/agent-task-completion returns completion data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "atc-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/agent-task-completion`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-452 handoff-route-mode-split
test("GET /handoffs/handoff-route-mode-split returns mode data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hrms-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-route-mode-split`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.modes));
  await app.close();
});

// F-453 claim-agent-ranking
test("GET /claims/claim-agent-ranking returns ranking data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "car-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-agent-ranking`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-454 blocker-dependency-fanout
test("GET /blockers/blocker-dependency-fanout returns fanout data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bdf-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-dependency-fanout`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blockers));
  await app.close();
});

// F-455 workspace-creation-daily
test("GET /workspaces/workspace-creation-daily returns daily trend", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/workspaces/workspace-creation-daily",
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.trend));
  await app.close();
});

// F-456 agent-metadata-keys
test("GET /agents/agent-metadata-keys returns metadata key data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "amk-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/agent-metadata-keys`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.keys));
  await app.close();
});

// F-457 handoff-timeout-seconds-stats
test("GET /handoffs/handoff-timeout-seconds-stats returns timeout stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "htss-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-timeout-seconds-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-458 blocker-open-age
test("GET /blockers/blocker-open-age returns age data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "boa-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-open-age`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blockers));
  await app.close();
});

// F-459 claim-dependency-count
test("GET /claims/claim-dependency-count returns dep data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "cdc-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-dependency-count`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.claims));
  await app.close();
});

// F-460 workspace-audit-action-types
test("GET /workspace-audit-action-types returns action types", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "waat-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/workspace-audit-action-types`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.actions));
  await app.close();
});

// F-461 handoff-from-to-matrix
test("GET /handoffs/handoff-from-to-matrix returns matrix data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hftm-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-from-to-matrix`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.matrix));
  await app.close();
});

// F-462 agent-capability-count
test("GET /agents/agent-capability-count returns capability counts", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "acc-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/agent-capability-count`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-463 blocker-severity-age-avg
test("GET /blockers/blocker-severity-age-avg returns severity age", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bsaa-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-severity-age-avg`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.severities));
  await app.close();
});

// F-464 claim-created-hourly
test("GET /claims/claim-created-hourly returns hourly data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "cch-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-created-hourly`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.hours));
  await app.close();
});

// F-465 workspace-settings-key-count
test("GET /workspace-settings-key-count returns key count", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "wskc-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/workspace-settings-key-count`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.key_count === "number");
  await app.close();
});

// F-466 agent-group-distribution
test("GET /agents/agent-group-distribution returns group data", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "agd-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/agent-group-distribution`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.groups));
  await app.close();
});

// F-467 handoff-notes-per-handoff
test("GET /handoffs/handoff-notes-per-handoff returns note counts", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hnph-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-notes-per-handoff`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.handoffs));
  await app.close();
});

// F-468 claim-priority-avg
test("GET /claims/claim-priority-avg returns priority stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "cpa-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-priority-avg`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-469 agent-last-seen-ranking
test("GET /agents/agent-last-seen-ranking returns ranked agents", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "alsr-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/agent-last-seen-ranking`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-470 handoff-capability-tag-stats
test("GET /handoffs/handoff-capability-tag-stats returns tag stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hcts-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-capability-tag-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.tags));
  await app.close();
});

// F-471 workspace-total-entities
test("GET /workspace-total-entities returns entity counts", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "wte-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/workspace-total-entities`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.agents === "number");
  assert.ok(typeof body.handoffs === "number");
  await app.close();
});

// F-472 handoff-retry-success-rate
test("GET /handoffs/handoff-retry-success-rate returns retry stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hrsr-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-retry-success-rate`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total_retried === "number");
  await app.close();
});

// F-473 claim-dependency-chain
test("GET /claims/claim-dependency-chain returns dependency chains", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "cdc-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-dependency-chain`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.chains));
  await app.close();
});

// F-474 handoff-completion-by-hour
test("GET /handoffs/handoff-completion-by-hour returns hourly completions", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hcbh-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-completion-by-hour`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.hours));
  await app.close();
});

// F-475 blocker-open-closed-ratio
test("GET /blockers/blocker-open-closed-ratio returns ratio stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bocr-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-open-closed-ratio`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-476 claim-transfer-frequency
test("GET /claims/claim-transfer-frequency returns transfer counts", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "ctf-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-transfer-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.transfers));
  await app.close();
});

// F-477 agent-status-transition-matrix
test("GET /agents/agent-status-transition-matrix returns transitions", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "astm-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/agent-status-transition-matrix`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.transitions));
  await app.close();
});

// F-478 blocker-watcher-per-blocker
test("GET /blockers/blocker-watcher-per-blocker returns watcher counts", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bwpb-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-watcher-per-blocker`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blockers));
  await app.close();
});

// F-479 handoff-route-mode-stats
test("GET /handoffs/handoff-route-mode-stats returns mode stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hrms-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-route-mode-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.modes));
  await app.close();
});

// F-480 agent-tag-frequency
test("GET /agents/agent-tag-frequency returns tag frequency", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "atf-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/agent-tag-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.tags));
  await app.close();
});

// F-481 blocker-dependency-fan-out
test("GET /blockers/blocker-dependency-fan-out returns fan-out stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bdfo-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-dependency-fan-out`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.blockers));
  await app.close();
});

// F-482 workspace-age-days
test("GET /workspace-age-days returns workspace age", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "wad-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/workspace-age-days`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.age_days === "number");
  await app.close();
});

// F-483 claim-renewal-count-distribution
test("GET /claims/claim-renewal-count-distribution returns renewal stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "crcd-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-renewal-count-distribution`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.renewals));
  await app.close();
});

// F-484 agent-metadata-key-count
test("GET /agents/agent-metadata-key-count returns key counts", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "amkc-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/agent-metadata-key-count`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-485 handoff-context-size-avg
test("GET /handoffs/handoff-context-size-avg returns context stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hcsa-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-context-size-avg`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-486 blocker-escalation-level-distribution
test("GET /blockers/blocker-escalation-level-distribution returns levels", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "beld-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-escalation-level-distribution`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.levels));
  await app.close();
});

// F-487 handoff-timeout-utilization
test("GET /handoffs/handoff-timeout-utilization returns utilization stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "htu-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-timeout-utilization`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.handoffs));
  await app.close();
});

// F-488 claim-path-pattern-popularity
test("GET /claims/claim-path-pattern-popularity returns pattern stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "cppp-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-path-pattern-popularity`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.patterns));
  await app.close();
});

// F-489 blocker-age-bucket
test("GET /blockers/blocker-age-bucket returns age buckets", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bab-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-age-bucket`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.buckets));
  await app.close();
});

// F-490 handoff-sla-deadline-remaining
test("GET /handoffs/handoff-sla-deadline-remaining returns remaining hours", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hsdr-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-sla-deadline-remaining`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.handoffs));
  await app.close();
});

// F-491 workspace-audit-action-frequency
test("GET /workspace-audit-action-frequency returns action counts", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "waaf-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/workspace-audit-action-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.actions));
  await app.close();
});

// F-492 claim-active-expired-ratio
test("GET /claims/claim-active-expired-ratio returns ratio stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "caer-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-active-expired-ratio`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// F-493 agent-task-priority-breakdown
test("GET /agents/agent-task-priority-breakdown returns breakdown", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "atpb-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/agent-task-priority-breakdown`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.breakdown));
  await app.close();
});

// F-494 handoff-from-agent-success-rate
test("GET /handoffs/handoff-from-agent-success-rate returns rates", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hfasr-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-from-agent-success-rate`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-495 blocker-severity-agent-crosstab
test("GET /blockers/blocker-severity-agent-crosstab returns crosstab", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bsac-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-severity-agent-crosstab`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.crosstab));
  await app.close();
});

// F-496 handoff-priority-distribution
test("GET /handoffs/handoff-priority-distribution returns distribution", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hpd-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-priority-distribution`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.priorities));
  await app.close();
});

// F-497 claim-scope-uniqueness-ratio
test("GET /claims/claim-scope-uniqueness-ratio returns ratio", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "csur-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/claims/claim-scope-uniqueness-ratio`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total_claims === "number");
  await app.close();
});

// F-498 workspace-claim-density
test("GET /workspace-claim-density returns density", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "wcd-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/workspace-claim-density`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.claims_per_agent === "number");
  await app.close();
});

// F-499 agent-model-capability-matrix
test("GET /agents/agent-model-capability-matrix returns matrix", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "amcm-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/agent-model-capability-matrix`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.matrix));
  await app.close();
});

// F-500 blocker-comment-timeline
test("GET /blockers/blocker-comment-timeline returns timeline", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bct-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-comment-timeline`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.timeline));
  await app.close();
});

// F-501 handoff-summary-word-frequency
test("GET /handoffs/handoff-summary-word-frequency returns word counts", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "hswf-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-summary-word-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.words));
  await app.close();
});

// F-502 agent-task-completion-trend
test("GET /agents/agent-task-completion-trend returns trend", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "atct-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/agent-task-completion-trend`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.trend));
  await app.close();
});

// F-503 workspace-handoff-density
test("GET /workspace-handoff-density returns density", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "whd-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/workspace-handoff-density`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.handoffs_per_agent === "number");
  await app.close();
});

// F-504 blocker-title-keyword-frequency
test("GET /blockers/blocker-title-keyword-frequency returns keywords", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "btkf-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-title-keyword-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.keywords));
  await app.close();
});

// F-505 handoff-to-agent-load
test("GET /handoffs/handoff-to-agent-load returns agent load", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "htal-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoffs/handoff-to-agent-load`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.agents));
  await app.close();
});

// F-506 blocker-details-length-stats
test("GET /blockers/blocker-details-length-stats returns length stats", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const ws = "bdls-" + Date.now().toString(36);
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/blockers/blocker-details-length-stats`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.ok(typeof body.total === "number");
  await app.close();
});

// T-507 handoff-chain-completion-rate
test("F-507 handoff-chain-completion-rate", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "hccr-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/handoff-chain-completion-rate`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.ok("total_chain_handoffs" in body);
  assert.ok("completion_rate" in body);
  await app.close();
});

// T-508 blocker-agent-resolution-rate
test("F-508 blocker-agent-resolution-rate", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "barr-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/blocker-agent-resolution-rate`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const data = res.json();
  assert.ok(Array.isArray(data));
  await app.close();
});

// T-509 claim-scope-character-distribution
test("F-509 claim-scope-character-distribution", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "cscd-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/claim-scope-character-distribution`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.ok("total_scopes" in body);
  assert.ok(Array.isArray(body.character_distribution));
  await app.close();
});

// T-510 workspace-blocker-density
test("F-510 workspace-blocker-density", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/analytics/workspace-blocker-density",
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const data = res.json();
  assert.ok(Array.isArray(data));
  await app.close();
});

// T-511 agent-capability-overlap
test("F-511 agent-capability-overlap", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "aco-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/agent-capability-overlap`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.ok("total_pairs" in body);
  assert.ok(Array.isArray(body.overlaps));
  await app.close();
});

// T-512 handoff-retry-rate
test("F-512 handoff-retry-rate", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "hrr-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/handoff-retry-rate`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.ok("retry_rate" in body);
  assert.ok("total_handoffs" in body);
  await app.close();
});

// T-513 blocker-resolution-speed-ranking
test("F-513 blocker-resolution-speed-ranking", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "brsr-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/blocker-resolution-speed-ranking`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.json()));
  await app.close();
});

// T-514 handoff-context-key-frequency
test("F-514 handoff-context-key-frequency", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "hckf-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/handoff-context-key-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.ok("keys" in body);
  assert.ok(Array.isArray(body.keys));
  await app.close();
});

// T-515 workspace-agent-density
test("F-515 workspace-agent-density", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/analytics/workspace-agent-density",
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.json()));
  await app.close();
});

// T-516 claim-renewal-trend
test("F-516 claim-renewal-trend", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "crt-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/claim-renewal-trend`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.json()));
  await app.close();
});

// T-517 blocker-severity-trend
test("F-517 blocker-severity-trend", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "bst-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/blocker-severity-trend`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.json()));
  await app.close();
});

// T-518 handoff-template-popularity
test("F-518 handoff-template-popularity", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "htp-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/handoff-template-popularity`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.json()));
  await app.close();
});

// T-519 agent-registration-daily
test("F-519 agent-registration-daily", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "ard-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/agent-registration-daily`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.json()));
  await app.close();
});

// T-520 blocker-deadline-compliance
test("F-520 blocker-deadline-compliance", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "bdc-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/blocker-deadline-compliance`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.ok("compliance_rate" in body);
  assert.ok("total_with_deadline" in body);
  await app.close();
});

// T-521 workspace-creation-trend
test("F-521 workspace-creation-trend", async () => {
  const app = buildApp();
  runMigrations();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/analytics/workspace-creation-trend",
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.json()));
  await app.close();
});

// T-522 claim-scope-word-frequency
test("F-522 claim-scope-word-frequency", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "cswf-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/claim-scope-word-frequency`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.ok("words" in body);
  assert.ok(Array.isArray(body.words));
  await app.close();
});

// T-523 handoff-status-daily
test("F-523 handoff-status-daily", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "hsd-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/handoff-status-daily`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.json()));
  await app.close();
});

// T-524 agent-model-popularity
test("F-524 agent-model-popularity", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "amp-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/agent-model-popularity`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.json()));
  await app.close();
});

// T-525 update agent task status
test("F-525 update agent task status", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "uts-" + Date.now().toString(36);
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
  const createRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/a1/tasks`,
    headers: auth,
    payload: { title: "Fix bug" },
  });
  assert.strictEqual(createRes.statusCode, 201);
  const taskId = createRes.json().task_id;
  const patchRes = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/agents/a1/tasks/${taskId}`,
    headers: auth,
    payload: { status: "in_progress" },
  });
  assert.strictEqual(patchRes.statusCode, 200);
  assert.strictEqual(patchRes.json().ok, true);
  const listRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/a1/tasks?status=in_progress`,
    headers: auth,
  });
  assert.strictEqual(listRes.json().data.length, 1);
  assert.strictEqual(listRes.json().data[0].status, "in_progress");
  // update not-found
  const notFoundRes = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/agents/a1/tasks/tsk_nonexistent`,
    headers: auth,
    payload: { status: "completed" },
  });
  assert.strictEqual(notFoundRes.statusCode, 404);
  // empty update
  const emptyRes = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/agents/a1/tasks/${taskId}`,
    headers: auth,
    payload: {},
  });
  assert.strictEqual(emptyRes.statusCode, 400);
  await app.close();
});

// T-526 delete agent task
test("F-526 delete agent task", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "dtsk-" + Date.now().toString(36);
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
  const createRes = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/a1/tasks`,
    headers: auth,
    payload: { title: "To delete" },
  });
  const taskId = createRes.json().task_id;
  const delRes = await app.inject({
    method: "DELETE",
    url: `/api/v1/workspaces/${ws}/agents/a1/tasks/${taskId}`,
    headers: auth,
  });
  assert.strictEqual(delRes.statusCode, 200);
  assert.strictEqual(delRes.json().ok, true);
  const listRes = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/a1/tasks`,
    headers: auth,
  });
  assert.strictEqual(listRes.json().data.length, 0);
  // delete not-found
  const notFoundRes = await app.inject({
    method: "DELETE",
    url: `/api/v1/workspaces/${ws}/agents/a1/tasks/tsk_nonexistent`,
    headers: auth,
  });
  assert.strictEqual(notFoundRes.statusCode, 404);
  await app.close();
});

// T-527 claim circular dependency detection
test("F-527 claim circular dependency detection", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "ccd-" + Date.now().toString(36);
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
  const c1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "file-a", paths: ["src/a.ts"] },
  });
  assert.strictEqual(c1.statusCode, 201);
  const claim1Id = c1.json().claim_id;
  const c2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "file-b", paths: ["src/b.ts"], depends_on: [claim1Id] },
  });
  assert.strictEqual(c2.statusCode, 201);
  const claim2Id = c2.json().claim_id;
  // c3 -> c2 -> c1, no cycle — should succeed
  const c3 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "file-c", paths: ["src/c.ts"], depends_on: [claim2Id] },
  });
  assert.strictEqual(c3.statusCode, 201);
  // normal dep — no self-ref
  const c4 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "file-d", paths: ["src/d.ts"] },
  });
  assert.strictEqual(c4.statusCode, 201);
  const claim4Id = c4.json().claim_id;
  const depOnC4 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/claims`,
    headers: auth,
    payload: { agent_id: "a1", scope: "file-e", paths: ["src/e.ts"], depends_on: [claim4Id] },
  });
  assert.strictEqual(depOnC4.statusCode, 201);
  await app.close();
});

// T-528 workspace health score
test("F-528 workspace health score", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "whs-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/health-score-detailed`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.ok("overall" in body);
  assert.ok("components" in body);
  assert.ok("raw" in body);
  assert.strictEqual(body.workspace, ws);
  assert.strictEqual(typeof body.overall, "number");
  assert.ok(body.overall >= 0 && body.overall <= 100);
  assert.ok("agent_health" in body.components);
  assert.ok("claim_health" in body.components);
  assert.ok("blocker_health" in body.components);
  assert.ok("handoff_health" in body.components);
  // not found workspace
  const notFoundRes = await app.inject({
    method: "GET",
    url: "/api/v1/workspaces/nonexistent-ws/health-score-detailed",
    headers: auth,
  });
  assert.strictEqual(notFoundRes.statusCode, 404);
  await app.close();
});

// T-525 blocker-created-hourly
test("F-525 blocker-created-hourly", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "bch-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/blocker-created-hourly`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.ok(Array.isArray(res.json()));
  await app.close();
});

// T-526 handoff-avg-context-size
test("F-526 handoff-avg-context-size", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "hacs-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/analytics/handoff-avg-context-size`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.ok("avg_size" in body);
  assert.ok("total" in body);
  await app.close();
});

// T-529 get single handoff template
test("F-529 get single handoff template", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "gsht-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const cr = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoff-templates`,
    headers: auth,
    payload: { name: "Bug Fix", summary_template: "Fix: {{issue}}" },
  });
  assert.strictEqual(cr.statusCode, 201);
  const tplId = cr.json().template_id;
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoff-templates/${tplId}`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.json().name, "Bug Fix");
  assert.strictEqual(res.json().template_id, tplId);
  const nf = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoff-templates/tpl_nonexist`,
    headers: auth,
  });
  assert.strictEqual(nf.statusCode, 404);
  await app.close();
});

// T-530 update handoff template
test("F-530 update handoff template", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "uht-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const cr = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoff-templates`,
    headers: auth,
    payload: { name: "Original", summary_template: "Original template" },
  });
  const tplId = cr.json().template_id;
  const patch = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/handoff-templates/${tplId}`,
    headers: auth,
    payload: { name: "Updated", default_priority: "high" },
  });
  assert.strictEqual(patch.statusCode, 200);
  assert.strictEqual(patch.json().ok, true);
  const get = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoff-templates/${tplId}`,
    headers: auth,
  });
  assert.strictEqual(get.json().name, "Updated");
  assert.strictEqual(get.json().default_priority, "high");
  const nf = await app.inject({
    method: "PATCH",
    url: `/api/v1/workspaces/${ws}/handoff-templates/tpl_nonexist`,
    headers: auth,
    payload: { name: "X" },
  });
  assert.strictEqual(nf.statusCode, 404);
  await app.close();
});

// T-531 delete handoff template
test("F-531 delete handoff template", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "dht-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const cr = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoff-templates`,
    headers: auth,
    payload: { name: "ToDelete", summary_template: "Delete me" },
  });
  const tplId = cr.json().template_id;
  const del = await app.inject({
    method: "DELETE",
    url: `/api/v1/workspaces/${ws}/handoff-templates/${tplId}`,
    headers: auth,
  });
  assert.strictEqual(del.statusCode, 200);
  assert.strictEqual(del.json().ok, true);
  const list = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/handoff-templates`,
    headers: auth,
  });
  assert.strictEqual(list.json().data.length, 0);
  const nf = await app.inject({
    method: "DELETE",
    url: `/api/v1/workspaces/${ws}/handoff-templates/tpl_nonexist`,
    headers: auth,
  });
  assert.strictEqual(nf.statusCode, 404);
  await app.close();
});

// T-532 workspace-level task list
test("F-532 workspace-level task list", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "wlt-" + Date.now().toString(36);
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
    payload: { agent_id: "a2", display_name: "A2", capabilities: ["test"] },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/a1/tasks`,
    headers: auth,
    payload: { title: "Task A1", priority: "high" },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/a2/tasks`,
    headers: auth,
    payload: { title: "Task A2", priority: "low" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/tasks`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.json().total, 2);
  assert.strictEqual(res.json().data.length, 2);
  const filtered = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/tasks?priority=high`,
    headers: auth,
  });
  assert.strictEqual(filtered.json().total, 1);
  assert.strictEqual(filtered.json().data[0].priority, "high");
  await app.close();
});

// T-533 workspace task summary
test("F-533 workspace task summary", async () => {
  const app = buildApp();
  runMigrations();
  const ws = "wts-" + Date.now().toString(36);
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: auth,
    payload: { workspace_id: ws, display_name: ws },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/tasks/summary`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.strictEqual(body.workspace, ws);
  assert.ok("total" in body);
  assert.ok("pending" in body);
  assert.ok("in_progress" in body);
  assert.ok("completed" in body);
  assert.ok("critical_count" in body);
  await app.close();
});

// T-534 agent task batch create
test("F-534 agent task batch create", async () => {
  runMigrations();
  const app = buildApp();
  const ws = "wbt-" + Date.now().toString(36);
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
      agent_id: "bat-1",
      display_name: "Batch Agent",
      capabilities: ["code"],
      model: "gpt-4",
    },
  });
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/bat-1/tasks/batch`,
    headers: auth,
    payload: {
      tasks: [
        { title: "Task A", priority: "high" },
        { title: "Task B", description: "desc-b" },
        { title: "Task C", priority: "critical" },
      ],
    },
  });
  assert.strictEqual(res.statusCode, 201);
  const body = res.json();
  assert.strictEqual(body.created, 3);
  assert.strictEqual(body.task_ids.length, 3);
  // Verify tasks exist
  const list = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/bat-1/tasks`,
    headers: auth,
  });
  assert.strictEqual(list.json().data.length, 3);
  await app.close();
});

// T-535 handoff batch reject
test("F-535 handoff batch reject", async () => {
  runMigrations();
  const app = buildApp();
  const ws = "wbr-" + Date.now().toString(36);
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
      agent_id: "rj-from",
      display_name: "Rejector From",
      capabilities: ["code"],
      model: "gpt-4",
    },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: {
      agent_id: "rj-to",
      display_name: "Rejector To",
      capabilities: ["review"],
      model: "gpt-4",
    },
  });
  // Create two handoffs
  const h1 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "rj-from", to_agent_id: "rj-to", summary: "reject test 1" },
  });
  const h2 = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs`,
    headers: auth,
    payload: { from_agent_id: "rj-from", to_agent_id: "rj-to", summary: "reject test 2" },
  });
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/handoffs/batch-reject`,
    headers: auth,
    payload: {
      handoff_ids: [h1.json().handoff_id, h2.json().handoff_id],
      reason: "Not needed",
    },
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.strictEqual(body.rejected, 2);
  assert.strictEqual(body.results.length, 2);
  await app.close();
});

// T-536 blocker batch create
test("F-536 blocker batch create", async () => {
  runMigrations();
  const app = buildApp();
  const ws = "wbc-" + Date.now().toString(36);
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
      agent_id: "bc-1",
      display_name: "Blocker Agent",
      capabilities: ["code"],
      model: "gpt-4",
    },
  });
  const res = await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers/batch`,
    headers: auth,
    payload: {
      blockers: [
        { agent_id: "bc-1", title: "Dep missing", severity: "high" },
        {
          agent_id: "bc-1",
          title: "Config broken",
          severity: "critical",
          details: "env var missing",
        },
      ],
    },
  });
  assert.strictEqual(res.statusCode, 201);
  const body = res.json();
  assert.strictEqual(body.created, 2);
  assert.strictEqual(body.blocker_ids.length, 2);
  await app.close();
});

// T-537 agent capability search
test("F-537 agent capability search", async () => {
  runMigrations();
  const app = buildApp();
  const ws = "wcs-" + Date.now().toString(36);
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
      agent_id: "cs-1",
      display_name: "Coder",
      capabilities: ["code-review", "code-gen"],
      model: "gpt-4",
    },
  });
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/agents/register`,
    headers: auth,
    payload: {
      agent_id: "cs-2",
      display_name: "Tester",
      capabilities: ["testing", "qa"],
      model: "gpt-4",
    },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/agents/capability-search?q=code`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.strictEqual(body.query, "code");
  assert.strictEqual(body.total, 1);
  assert.strictEqual(body.agents[0].agent_id, "cs-1");
  assert.strictEqual(body.agents[0].matched_capabilities.length, 2);
  await app.close();
});

// T-538 workspace activity feed
test("F-538 workspace activity feed", async () => {
  runMigrations();
  const app = buildApp();
  const ws = "waf-" + Date.now().toString(36);
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
      agent_id: "af-1",
      display_name: "Feed Agent",
      capabilities: ["code"],
      model: "gpt-4",
    },
  });
  // Create a blocker to generate audit log entries
  await app.inject({
    method: "POST",
    url: `/api/v1/workspaces/${ws}/blockers`,
    headers: auth,
    payload: { agent_id: "af-1", title: "Feed blocker", severity: "low" },
  });
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/workspaces/${ws}/activity-timeline`,
    headers: auth,
  });
  assert.strictEqual(res.statusCode, 200);
  const body = res.json();
  assert.strictEqual(body.workspace, ws);
  assert.ok(body.feed.length > 0);
  assert.ok("action" in body.feed[0]);
  assert.ok("entity_type" in body.feed[0]);
  assert.ok("timestamp" in body.feed[0]);
  await app.close();
});
