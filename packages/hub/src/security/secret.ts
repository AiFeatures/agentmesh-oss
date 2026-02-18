import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SECRET_DIR = path.join(os.homedir(), ".agentmesh");
const SECRET_PATH = path.join(SECRET_DIR, "secret");

export function getSharedSecret(): string {
  mkdirSync(SECRET_DIR, { recursive: true });
  try {
    const secret = readFileSync(SECRET_PATH, "utf8").trim();
    if (secret.length > 0) {
      return secret;
    }
  } catch {
    // continue
  }

  const generated = randomBytes(48).toString("base64url");
  writeFileSync(SECRET_PATH, generated, { mode: 0o600 });
  return generated;
}
