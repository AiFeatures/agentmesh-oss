import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_PATH = process.env.AGENTMESH_SQLITE_PATH
  ? path.resolve(process.env.AGENTMESH_SQLITE_PATH)
  : path.join(DATA_DIR, "agentmesh.sqlite");

mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS migrations (
  version TEXT PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

export function runMigrations(): void {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const migrationDir = currentDir.includes(`${path.sep}dist${path.sep}`)
    ? path.resolve(currentDir, "../../src/db/migrations")
    : path.resolve(currentDir, "migrations");
  const files = readdirSync(migrationDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const appliedStmt = db.prepare("SELECT 1 FROM migrations WHERE version = ? LIMIT 1");
  const insertStmt = db.prepare("INSERT INTO migrations (version) VALUES (?)");

  for (const file of files) {
    if (appliedStmt.get(file)) {
      continue;
    }
    const sql = readFileSync(path.join(migrationDir, file), "utf8");
    const txn = db.transaction(() => {
      db.exec(sql);
      insertStmt.run(file);
    });
    txn();
  }

  db.prepare(
    "INSERT OR IGNORE INTO workspaces (workspace_id, display_name, base_path) VALUES ('default', 'Default Workspace', NULL)",
  ).run();
}
