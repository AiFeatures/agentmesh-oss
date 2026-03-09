import { Command } from "commander";
import { printResponse, readConfig, readSecret } from "../config.js";

function authHeader(): Record<string, string> {
  return { authorization: `Bearer ${readSecret()}` };
}

export function workspaceCommand(): Command {
  const command = new Command("workspace");

  command
    .command("create")
    .requiredOption("--name <displayName>", "workspace display name")
    .option("--id <workspaceId>", "workspace identifier")
    .option("--base-path <basePath>", "workspace base path")
    .action(async (opts: { name: string; id?: string; basePath?: string }) => {
      const cfg = readConfig();
      const response = await fetch(`${cfg.hubUrl}/api/v1/workspaces`, {
        method: "POST",
        headers: {
          ...authHeader(),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workspace_id: opts.id,
          display_name: opts.name,
          base_path: opts.basePath,
        }),
      });
      await printResponse(response);
    });

  command
    .command("delete")
    .requiredOption("--id <workspaceId>", "workspace identifier to delete")
    .action(async (opts: { id: string }) => {
      const cfg = readConfig();
      const response = await fetch(
        `${cfg.hubUrl}/api/v1/workspaces/${encodeURIComponent(opts.id)}`,
        {
          method: "DELETE",
          headers: authHeader(),
        },
      );
      await printResponse(response);
    });

  command.command("list").action(async () => {
    const cfg = readConfig();
    const response = await fetch(`${cfg.hubUrl}/api/v1/workspaces`, {
      headers: authHeader(),
    });
    await printResponse(response);
  });

  return command;
}
