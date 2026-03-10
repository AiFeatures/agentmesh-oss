import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "../src/app.js";
import { getSharedSecret } from "../src/security/secret.js";

test("GET /health returns ok payload and request id header", async () => {
  const app = buildApp();
  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  const body = response.json() as { status: string; service: string };
  assert.equal(body.status, "ok");
  assert.equal(body.service, "agentmesh-hub");
  assert.ok(response.headers["x-request-id"]);

  await app.close();
});

test("unknown route returns structured 404", async () => {
  const app = buildApp();
  const response = await app.inject({ method: "GET", url: "/does-not-exist" });
  assert.equal(response.statusCode, 404);
  const body = response.json() as { error: string; status: number };
  assert.equal(body.error, "Not found");
  assert.equal(body.status, 404);
  await app.close();
});

test("validation error returns structured 400", async () => {
  const app = buildApp();
  const auth = { authorization: `Bearer ${getSharedSecret()}` };
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/workspaces",
    headers: { ...auth, "content-type": "application/json" },
    payload: { display_name: "" },
  });
  assert.equal(response.statusCode, 400);
  const body = response.json() as { error: string; status: number };
  assert.equal(body.error, "Validation failed");
  assert.equal(body.status, 400);
  await app.close();
});
