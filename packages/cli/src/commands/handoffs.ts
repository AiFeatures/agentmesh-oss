import { Command } from "commander";
import { printResponse, readConfig, readSecret } from "../config.js";

export function handoffsCommand(): Command {
  return new Command("handoffs")
    .option("-w, --workspace <workspace>", "workspace override")
    .option("--status <status>", "handoff status filter", "pending")
    .action(async (opts: { workspace?: string; status?: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const status = opts.status ?? "pending";
      const response = await fetch(
        `${cfg.hubUrl}/api/v1/workspaces/${workspace}/handoffs?status=${encodeURIComponent(status)}`,
        {
          headers: { authorization: `Bearer ${readSecret()}` },
        },
      );
      await printResponse(response);
    });
}
