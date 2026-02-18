import { Command } from "commander";
import { readConfig, readSecret } from "../config.js";

export function agentsCommand(): Command {
  return new Command("agents")
    .option("-w, --workspace <workspace>", "workspace override")
    .action(async (opts: { workspace?: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const response = await fetch(`${cfg.hubUrl}/api/v1/workspaces/${workspace}/agents`, {
        headers: { authorization: `Bearer ${readSecret()}` },
      });
      console.log(await response.text());
    });
}
