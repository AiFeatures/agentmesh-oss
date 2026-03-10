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

  command
    .command("update")
    .requiredOption("--id <workspaceId>", "workspace identifier to update")
    .option("--name <displayName>", "new display name")
    .option("--base-path <basePath>", "new base path")
    .action(async (opts: { id: string; name?: string; basePath?: string }) => {
      const cfg = readConfig();
      const body: Record<string, string> = {};
      if (opts.name) body.display_name = opts.name;
      if (opts.basePath) body.base_path = opts.basePath;
      const response = await fetch(
        `${cfg.hubUrl}/api/v1/workspaces/${encodeURIComponent(opts.id)}`,
        {
          method: "PATCH",
          headers: { ...authHeader(), "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      await printResponse(response);
    });

  command
    .command("export")
    .description("Export all workspace data")
    .option("-w, --workspace <workspace>", "workspace override")
    .action(async (opts: { workspace?: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const response = await fetch(
        `${cfg.hubUrl}/api/v1/workspaces/${encodeURIComponent(workspace)}/export`,
        { headers: authHeader() },
      );
      await printResponse(response);
    });

  return command;
}
