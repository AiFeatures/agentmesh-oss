import { Command } from "commander";
import { printResponse, readConfig, readSecret } from "../config.js";

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${readSecret()}`,
    "content-type": "application/json",
  };
}

export function handoffsCommand(): Command {
  const cmd = new Command("handoffs").description("Manage task handoffs");

  cmd
    .command("list")
    .description("List handoffs in a workspace")
    .option("-w, --workspace <workspace>", "workspace override")
    .option("--status <status>", "filter by status", "pending")
    .action(async (opts: { workspace?: string; status: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const url = `${cfg.hubUrl}/api/v1/workspaces/${workspace}/handoffs?status=${encodeURIComponent(opts.status)}`;
      const response = await fetch(url, { headers: authHeaders() });
      await printResponse(response);
    });

  cmd
    .command("create")
    .description("Create a new handoff")
    .requiredOption("--from <agentId>", "source agent ID")
    .requiredOption("--to <agentId>", "target agent ID")
    .requiredOption("--scope <scope>", "handoff scope")
    .option("-w, --workspace <workspace>", "workspace override")
    .option("--summary <text>", "handoff summary")
    .option("--timeout <seconds>", "timeout in seconds")
    .action(
      async (opts: {
        workspace?: string;
        from: string;
        to: string;
        scope: string;
        summary?: string;
        timeout?: string;
      }) => {
        const cfg = readConfig();
        const workspace = opts.workspace ?? cfg.workspace;
        const body: Record<string, unknown> = {
          workspace,
          from_agent: opts.from,
          to_agent: opts.to,
          scope: opts.scope,
        };
        if (opts.summary) body.summary = opts.summary;
        if (opts.timeout) body.timeout_seconds = Number(opts.timeout);
        const response = await fetch(`${cfg.hubUrl}/api/v1/workspaces/${workspace}/handoffs`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(body),
        });
        await printResponse(response);
      },
    );

  cmd
    .command("accept <handoffId>")
    .description("Accept a pending handoff")
    .option("-w, --workspace <workspace>", "workspace override")
    .action(async (handoffId: string, opts: { workspace?: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const response = await fetch(
        `${cfg.hubUrl}/api/v1/workspaces/${workspace}/handoffs/${handoffId}/accept`,
        { method: "POST", headers: authHeaders() },
      );
      await printResponse(response);
    });

  cmd
    .command("reject <handoffId>")
    .description("Reject a pending handoff")
    .option("-w, --workspace <workspace>", "workspace override")
    .action(async (handoffId: string, opts: { workspace?: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const response = await fetch(
        `${cfg.hubUrl}/api/v1/workspaces/${workspace}/handoffs/${handoffId}/reject`,
        { method: "POST", headers: authHeaders() },
      );
      await printResponse(response);
    });

  return cmd;
}
