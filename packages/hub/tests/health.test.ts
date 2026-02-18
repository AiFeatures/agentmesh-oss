import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";

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
