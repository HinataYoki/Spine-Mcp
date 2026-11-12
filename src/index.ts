#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { SpineCli } from "./spine/cli.js";
import { registerTools } from "./tools/register.js";
import { registerWriteTools } from "./tools/write-tools.js";
import { registerAnalysisTools } from "./tools/analysis-tools.js";
import { registerExportTools } from "./tools/export-tools.js";
import { registerReimportTools } from "./tools/reimport-tools.js";
import { registerEditorTools } from "./tools/editor-tools.js";
import { registerQaTools } from "./tools/qa-tools.js";
import { profileDefaults } from "./tools/profile.js";
import { registerAnimationEditTools } from "./tools/animation-edit-tools.js";
import { installToolPolicy } from "./tools/policy.js";

const INSTRUCTIONS = `Spine 4.3. Absolute paths; seconds, degrees, skeleton units. Start with spine_inspect; use spine_doctor for setup failures. Writes default to dry-run: prefer new names, then apply:true. While editor is open, use returned staging project and importSteps. Oversized text returns a summary and paged report resource; read only needed pages. CLI calls are serialized and cached. SPINE_MCP_TOOLSET: core=minimal, animation=default, all=optional asset/QA/media/Unity tools.`;

const config = loadConfig();
const server = profileDefaults(installToolPolicy(new McpServer({ name: "spine-mcp", version: "0.70.1" }, {
  instructions: INSTRUCTIONS, maxToolInputElements: 250_000,
}), config, process.env.SPINE_MCP_TOOLSET ?? "animation"), config);
const cli = new SpineCli(config);
registerTools(server, config, cli);
registerWriteTools(server, config, cli);
registerAnimationEditTools(server, config, cli);
registerExportTools(server, config, cli);
registerAnalysisTools(server, config, cli);
registerReimportTools(server, config, cli);
registerEditorTools(server, config, cli);
registerQaTools(server, config, cli);
await server.connect(new StdioServerTransport());
