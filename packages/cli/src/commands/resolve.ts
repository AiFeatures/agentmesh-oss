import { Command } from "commander";
import { printResponse, readConfig, readSecret } from "../config.js";

export function resolveCommand(): Command {
  return new Command("resolve")
    .argument("<blocker_id>")
    .argument("<option>")
    .option("-w, --workspace <workspace>", "workspace override")
    .action(async (blockerId: string, option: string, opts: { workspace?: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const response = await fetch(
        `${cfg.hubUrl}/api/v1/workspaces/${workspace}/blockers/${blockerId}/resolve`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${readSecret()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ option }),
        },
      );
      await printResponse(response);
    });
}
