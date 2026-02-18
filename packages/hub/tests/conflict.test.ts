import test from "node:test";
import assert from "node:assert/strict";
import { patternsConflict } from "../src/services/conflict.js";

test("detects direct path conflicts", () => {
  assert.equal(patternsConflict("backend/routes/auth.py", "backend/routes/auth.py"), true);
  assert.equal(patternsConflict("backend/routes/auth.py", "backend/routes/users.py"), false);
});

test("detects glob path conflicts", () => {
  assert.equal(patternsConflict("backend/**", "backend/routes/auth.py"), true);
  assert.equal(patternsConflict("web/**", "backend/routes/auth.py"), false);
  assert.equal(patternsConflict("**/*.ts", "packages/hub/src/server.ts"), true);
});
