import { Command } from "commander";
import { readConfig, readSecret } from "../config.js";

export function statusCommand(): Command {
  return new Command("status")
    .description("Show workspace status summary")
    .option("-w, --workspace <workspace>", "workspace override")
    .option("--health", "include hub health info")
    .action(async (opts: { workspace?: string; health?: boolean }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const auth = { authorization: `Bearer ${readSecret()}` };

      const requests: Promise<Response>[] = [
        fetch(`${cfg.hubUrl}/api/v1/workspaces/${workspace}/stats`, { headers: auth }),
        fetch(`${cfg.hubUrl}/api/v1/workspaces/${workspace}/handoffs?status=pending`, {
          headers: auth,
        }),
      ];
      if (opts.health) {
        requests.push(fetch(`${cfg.hubUrl}/health`, { headers: auth }));
      }

      const responses = await Promise.all(requests);
      const stats = (await responses[0].json()) as Record<string, unknown>;
      const pendingHandoffs = (await responses[1].json()) as { data?: unknown[]; total?: number };

      const output: Record<string, unknown> = {
        workspace,
        ...stats,
        pending_handoffs: pendingHandoffs.total ?? (pendingHandoffs.data ?? []).length,
      };

      if (opts.health && responses[2]) {
        output.hub_health = await responses[2].json();
      }

      console.log(JSON.stringify(output, null, 2));
    });
}
