import { Command } from "commander";
import { printResponse, readConfig, readSecret } from "../config.js";

export function gcCommand(): Command {
  return new Command("gc")
    .option("-w, --workspace <workspace>", "workspace override")
    .action(async (opts: { workspace?: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const response = await fetch(`${cfg.hubUrl}/api/v1/workspaces/${workspace}/claims/gc`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${readSecret()}`,
        },
      });
      await printResponse(response);
    });
}
