import { Command } from "commander";
import { readConfig, readSecret } from "../config.js";

export function statusCommand(): Command {
  return new Command("status")
    .option("-w, --workspace <workspace>", "workspace override")
    .action(async (opts: { workspace?: string }) => {
      const cfg = readConfig();
      const workspace = opts.workspace ?? cfg.workspace;
      const auth = { authorization: `Bearer ${readSecret()}` };

      const [agentsRes, claimsRes, blockersRes] = await Promise.all([
        fetch(`${cfg.hubUrl}/api/v1/workspaces/${workspace}/agents`, { headers: auth }),
        fetch(`${cfg.hubUrl}/api/v1/workspaces/${workspace}/claims`, { headers: auth }),
        fetch(`${cfg.hubUrl}/api/v1/workspaces/${workspace}/blockers`, { headers: auth }),
      ]);

      const agents = (await agentsRes.json()) as { data?: unknown[] };
      const claims = (await claimsRes.json()) as { data?: unknown[] };
      const blockers = (await blockersRes.json()) as { data?: Array<{ status?: string }> };

      const openBlockers = (blockers.data ?? []).filter((item) => item.status !== "resolved");
      console.log(
        JSON.stringify(
          {
            workspace,
            agents: (agents.data ?? []).length,
            active_claims: (claims.data ?? []).length,
            open_blockers: openBlockers.length,
          },
          null,
          2,
        ),
      );
    });
}
