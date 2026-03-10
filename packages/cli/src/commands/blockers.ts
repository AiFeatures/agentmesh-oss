import { Command } from "commander";
import { printResponse, readConfig, readSecret } from "../config.js";

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${readSecret()}`,
    "content-type": "application/json",
  };
}

export function blockersCommand(): Command {
  const cmd = new Command("blockers").description("Manage blockers");

  cmd
    .command("list")
    .description("List blockers in a workspace")
    .option("-w, --workspace <workspace>", "workspace override")
    .option("--status <status>", "filter by status")
    .action(async (opts: { workspace?: string; status?: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const params = new URLSearchParams();
      if (opts.status) params.set("status", opts.status);
      const qs = params.toString();
      const url = `${cfg.hubUrl}/api/v1/workspaces/${workspace}/blockers${qs ? `?${qs}` : ""}`;
      const response = await fetch(url, { headers: authHeaders() });
      await printResponse(response);
    });

  cmd
    .command("create")
    .description("Create a new blocker")
    .requiredOption("--agent <agentId>", "agent ID raising the blocker")
    .requiredOption("--scope <scope>", "blocker scope")
    .requiredOption("--description <text>", "blocker description")
    .option("-w, --workspace <workspace>", "workspace override")
    .option("--severity <severity>", "severity: low|medium|high|critical", "medium")
    .option("--deadline <iso>", "ISO 8601 deadline")
    .action(
      async (opts: {
        workspace?: string;
        agent: string;
        scope: string;
        description: string;
        severity: string;
        deadline?: string;
      }) => {
        const cfg = readConfig();
        const workspace = opts.workspace ?? cfg.workspace;
        const body: Record<string, unknown> = {
          agent_id: opts.agent,
          scope: opts.scope,
          description: opts.description,
          severity: opts.severity,
        };
        if (opts.deadline) body.deadline_at = opts.deadline;
        const response = await fetch(`${cfg.hubUrl}/api/v1/workspaces/${workspace}/blockers`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(body),
        });
        await printResponse(response);
      },
    );

  cmd
    .command("resolve <blockerId>")
    .description("Resolve a blocker")
    .requiredOption("--note <text>", "resolution note")
    .option("-w, --workspace <workspace>", "workspace override")
    .option("--resolved-by <agentId>", "agent resolving")
    .action(
      async (
        blockerId: string,
        opts: { workspace?: string; note: string; resolvedBy?: string },
      ) => {
        const cfg = readConfig();
        const workspace = opts.workspace ?? cfg.workspace;
        const body: Record<string, unknown> = { note: opts.note };
        if (opts.resolvedBy) body.resolved_by = opts.resolvedBy;
        const response = await fetch(
          `${cfg.hubUrl}/api/v1/workspaces/${workspace}/blockers/${blockerId}/resolve`,
          {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(body),
          },
        );
        await printResponse(response);
      },
    );

  return cmd;
}
