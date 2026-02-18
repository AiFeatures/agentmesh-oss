import { Command } from "commander";
import { readConfig, writeConfig } from "../config.js";

export function initCommand(): Command {
  return new Command("init")
    .option("--hub <url>", "AgentMesh hub URL", "http://localhost:3777")
    .option("--workspace <workspace>", "default workspace", "default")
    .action((opts: { hub: string; workspace: string }) => {
      const current = readConfig();
      writeConfig({
        hubUrl: opts.hub ?? current.hubUrl,
        workspace: opts.workspace ?? current.workspace,
      });
      console.log(
        JSON.stringify({ ok: true, hubUrl: opts.hub, workspace: opts.workspace }, null, 2),
      );
    });
}
