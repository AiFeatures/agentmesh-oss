import { Command } from "commander";
import { printResponse, readConfig, readSecret } from "../config.js";

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${readSecret()}`,
    "content-type": "application/json",
  };
}

export function claimsCommand(): Command {
  const cmd = new Command("claims").description("Manage file-path claims");

  cmd
    .command("list")
    .description("List claims in a workspace")
    .option("-w, --workspace <workspace>", "workspace override")
    .option("--status <status>", "filter by status")
    .action(async (opts: { workspace?: string; status?: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const params = new URLSearchParams();
      if (opts.status) params.set("status", opts.status);
      const qs = params.toString();
      const url = `${cfg.hubUrl}/api/v1/workspaces/${workspace}/claims${qs ? `?${qs}` : ""}`;
      const response = await fetch(url, { headers: authHeaders() });
      await printResponse(response);
    });

  cmd
    .command("create")
    .description("Create a new claim")
    .requiredOption("--agent <agentId>", "agent ID")
    .requiredOption("--scope <scope>", "claim scope")
    .requiredOption("--paths <paths...>", "file path patterns")
    .option("-w, --workspace <workspace>", "workspace override")
    .option("--ttl <seconds>", "TTL in seconds")
    .action(
      async (opts: {
        workspace?: string;
        agent: string;
        scope: string;
        paths: string[];
        ttl?: string;
      }) => {
        const cfg = readConfig();
        const workspace = opts.workspace ?? cfg.workspace;
        const body: Record<string, unknown> = {
          agent_id: opts.agent,
          scope: opts.scope,
          paths: opts.paths,
        };
        if (opts.ttl) body.ttl_seconds = Number(opts.ttl);
        const response = await fetch(`${cfg.hubUrl}/api/v1/workspaces/${workspace}/claims`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(body),
        });
        await printResponse(response);
      },
    );

  cmd
    .command("release <claimId>")
    .description("Release an active claim")
    .option("-w, --workspace <workspace>", "workspace override")
    .action(async (claimId: string, opts: { workspace?: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const response = await fetch(
        `${cfg.hubUrl}/api/v1/workspaces/${workspace}/claims/${claimId}/release`,
        { method: "POST", headers: authHeaders() },
      );
      await printResponse(response);
    });

  cmd
    .command("renew <claimId>")
    .description("Renew an active claim")
    .option("-w, --workspace <workspace>", "workspace override")
    .option("--ttl <seconds>", "new TTL in seconds", "1800")
    .action(async (claimId: string, opts: { workspace?: string; ttl: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const response = await fetch(
        `${cfg.hubUrl}/api/v1/workspaces/${workspace}/claims/${claimId}/renew`,
        {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ ttl_seconds: Number(opts.ttl) }),
        },
      );
      await printResponse(response);
    });

  cmd
    .command("gc")
    .description("Garbage collect expired claims")
    .option("-w, --workspace <workspace>", "workspace override")
    .action(async (opts: { workspace?: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const response = await fetch(`${cfg.hubUrl}/api/v1/workspaces/${workspace}/claims/gc`, {
        method: "POST",
        headers: authHeaders(),
      });
      await printResponse(response);
    });

  return cmd;
}
