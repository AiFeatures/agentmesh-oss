import { Command } from "commander";
import { printResponse, readConfig, readSecret } from "../config.js";

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${readSecret()}`,
    "content-type": "application/json",
  };
}

export function agentsCommand(): Command {
  const cmd = new Command("agents").description("Manage agents");

  cmd
    .command("list")
    .description("List agents in a workspace")
    .option("-w, --workspace <workspace>", "workspace override")
    .option("--status <status>", "filter by status")
    .action(async (opts: { workspace?: string; status?: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const params = new URLSearchParams();
      if (opts.status) params.set("status", opts.status);
      const qs = params.toString();
      const url = `${cfg.hubUrl}/api/v1/workspaces/${workspace}/agents${qs ? `?${qs}` : ""}`;
      const response = await fetch(url, { headers: authHeaders() });
      await printResponse(response);
    });

  cmd
    .command("deregister <agentId>")
    .description("Deregister an agent")
    .option("-w, --workspace <workspace>", "workspace override")
    .action(async (agentId: string, opts: { workspace?: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const response = await fetch(
        `${cfg.hubUrl}/api/v1/workspaces/${workspace}/agents/${agentId}`,
        { method: "DELETE", headers: authHeaders() },
      );
      await printResponse(response);
    });

  cmd
    .command("status <agentId> <status>")
    .description("Update agent status (online|idle|blocked)")
    .option("-w, --workspace <workspace>", "workspace override")
    .action(async (agentId: string, status: string, opts: { workspace?: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const response = await fetch(
        `${cfg.hubUrl}/api/v1/workspaces/${workspace}/agents/${agentId}/status`,
        {
          method: "PATCH",
          headers: authHeaders(),
          body: JSON.stringify({ status }),
        },
      );
      await printResponse(response);
    });

  return cmd;
}
