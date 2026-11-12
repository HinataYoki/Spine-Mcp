import { cpSync, mkdirSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = resolve(import.meta.dirname, "..");
const sourceDir = resolve(repo, "DFY");
const workDir = resolve(repo, ".lab", "dfy-write");
const project = join(workDir, "DFY.spine");
const outputDir = join(workDir, "outputs");
if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
cpSync(sourceDir, workDir, { recursive: true });

const env = {
  ...process.env,
  SPINE_BIN: process.env.SPINE_BIN ?? "C:\\Program Files\\Spine\\Spine.com",
  SPINE_VERSION: process.env.SPINE_VERSION ?? "4.3.26",
  SPINE_MCP_WORKDIR: join(workDir, "mcp-work"),
};
const client = new Client({ name: "dfy-verification", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, "dist", "index.js")], env }));

async function call(name, args) {
  const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  const text = response.content.find((item) => item.type === "text")?.text ?? "";
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  console.log(`\n## ${name} ${response.isError ? "ERROR" : "ok"}`);
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2).slice(0, 8000));
  if (response.isError) throw new Error(`${name}: ${text}`);
  return value;
}

await call("spine_doctor", {});
const before = await call("spine_project_info", { paths: [project] });
await call("spine_generate_animation", {
  project,
  skeleton: "DFY",
  type: "breathe",
  name: "ai_breathe",
  breathe: { torso: ["胸"], followers: ["头"], period: 2.0, amount: 0.04, rise: 0.25, restStart: true },
  apply: true,
});
const after = await call("spine_project_info", { paths: [project] });
await call("spine_inspect", { input: project, skeleton: "DFY", view: "animation", animation: "ai_breathe", owner: "胸" });
const validation = await call("spine_validate", { input: project, skeleton: "DFY", loopAnimations: ["ai_breathe"] });
await call("spine_render_frames", { project, skeleton: "DFY", animation: "ai_breathe", maxFrames: 9, outputDir });
const exportRoot = join(workDir, "mcp-work", "exports");
const exportFolders = existsSync(exportRoot) ? readdirSync(exportRoot).map((name) => join(exportRoot, name)).filter((p) => existsSync(join(p, "DFY.json"))) : [];
const jsonPath = exportFolders.sort().at(-1) ? join(exportFolders.sort().at(-1), "DFY.json") : "";
const exported = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, "utf8")) : null;
console.log("\n## verification-summary");
console.log(JSON.stringify({
  project,
  beforeAnimations: before.projects?.[0]?.skeletons?.[0]?.lists?.Animations,
  afterAnimations: after.projects?.[0]?.skeletons?.[0]?.lists?.Animations,
  validation: { errors: validation.errors, warnings: validation.warnings },
  exportedCachePath: jsonPath,
  exportedHasAiBreathe: !!exported?.animations?.ai_breathe,
}, null, 2));
await client.close();
