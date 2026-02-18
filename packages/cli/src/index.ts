#!/usr/bin/env node
import { Command } from "commander";
import { agentsCommand } from "./commands/agents.js";
import { blockersCommand } from "./commands/blockers.js";
import { claimsCommand } from "./commands/claims.js";
import { gcCommand } from "./commands/gc.js";
import { handoffsCommand } from "./commands/handoffs.js";
import { initCommand } from "./commands/init.js";
import { resolveCommand } from "./commands/resolve.js";
import { statusCommand } from "./commands/status.js";
import { workspaceCommand } from "./commands/workspace.js";

const program = new Command();

program.name("mesh").description("AgentMesh CLI");
program.addCommand(initCommand());
program.addCommand(workspaceCommand());
program.addCommand(agentsCommand());
program.addCommand(claimsCommand());
program.addCommand(handoffsCommand());
program.addCommand(blockersCommand());
program.addCommand(resolveCommand());
program.addCommand(statusCommand());
program.addCommand(gcCommand());

program.parse();
