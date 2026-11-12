// End-to-end check: starts the built server over stdio and calls every tool like an MCP client would.
// Usage (outside the Claude Code sandbox): npm run build && node scripts/smoke.mjs <project.spine> <animation> [outDir]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [project, animation, outDir = join(process.cwd(), ".lab", "smoke")] = process.argv.slice(2);
if (!project || !animation) {
  console.error("usage: node scripts/smoke.mjs <project.spine> <animation> [outDir]");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

async function call(name, args) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  const image = r.content.find((c) => c.type === "image");
  console.log(`\n## ${name} ${r.isError ? "ERROR" : "ok"} (${Date.now() - t0} ms, ${text.length} chars${image ? ", +image" : ""})`);
  console.log(text.length > 1200 ? `${text.slice(0, 1200)}\n…` : text);
  if (image) writeFileSync(join(outDir, `${name}.png`), Buffer.from(image.data, "base64"));
  return r;
}

await call("spine_doctor", {});
await call("spine_project_info", { paths: [project] });
await call("spine_export_json", { project });
await call("spine_inspect", { input: project });
await call("spine_inspect", { input: project, view: "animation", animation });
await call("spine_validate", { input: project });
await call("spine_measure", { input: project, animation });
await call("spine_render_frames", { project, animation, maxFrames: 9 });
await call("spine_inspect", { input: "relative/path.spine" });
await client.close();
