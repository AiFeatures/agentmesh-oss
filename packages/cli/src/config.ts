import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type MeshConfig = {
  hubUrl: string;
  workspace: string;
};

const CONFIG_DIR = path.join(os.homedir(), ".agentmesh");
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");
const SECRET_PATH = path.join(CONFIG_DIR, "secret");

export function readSecret(): string {
  return readFileSync(SECRET_PATH, "utf8").trim();
}

export function readConfig(): MeshConfig {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<MeshConfig>;
    return {
      hubUrl: parsed.hubUrl ?? "http://localhost:3777",
      workspace: parsed.workspace ?? "default",
    };
  } catch {
    return { hubUrl: "http://localhost:3777", workspace: "default" };
  }
}

export function writeConfig(config: MeshConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export async function printResponse(response: Response): Promise<void> {
  const text = await response.text();
  if (!response.ok) {
    console.error(`Error ${response.status}: ${text}`);
    process.exitCode = 1;
    return;
  }
  try {
    const json = JSON.parse(text);
    console.log(JSON.stringify(json, null, 2));
  } catch {
    console.log(text);
  }
}
