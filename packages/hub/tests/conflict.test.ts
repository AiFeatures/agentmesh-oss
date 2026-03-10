import assert from "node:assert/strict";
import test from "node:test";
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

test("non-overlapping globs do not conflict", () => {
  assert.equal(patternsConflict("src/**/*.ts", "lib/**/*.js"), false);
  assert.equal(patternsConflict("frontend/**", "backend/**"), false);
});

test("double-star vs double-star overlap", () => {
  assert.equal(patternsConflict("src/**", "src/**/*.ts"), true);
  assert.equal(patternsConflict("**/*.ts", "src/**"), true);
});

test("question mark wildcard matching", () => {
  assert.equal(patternsConflict("src/?.ts", "src/a.ts"), true);
  assert.equal(patternsConflict("src/?.ts", "src/ab.ts"), false);
});

test("identical patterns always conflict", () => {
  assert.equal(patternsConflict("**/*", "**/*"), true);
  assert.equal(patternsConflict("src/**/*.ts", "src/**/*.ts"), true);
});

test("single file vs unrelated glob no conflict", () => {
  assert.equal(patternsConflict("README.md", "src/**"), false);
  assert.equal(patternsConflict("package.json", "tests/**/*.test.ts"), false);
});
