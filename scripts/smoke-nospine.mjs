import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const repo = process.cwd(), root = mkdtempSync(join(tmpdir(), "spine-mcp-nospine-"));
process.on("exit", () => { if (!process.env.KEEP_TMP) rmSync(root, { recursive: true, force: true }); });
const dir = join(root, "DFY"), json = join(dir, "DFY.json"), project = join(dir, "DFY.spine");
cpSync(join(repo, "DFY"), dir, { recursive: true });
cpSync(join(repo, "tests", "fixtures", "dfy.json"), json);
const client = new Client({ name: "smoke-nospine", version: "1" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, "dist", "index.js")], env: { ...process.env, SPINE_MCP_TOOLSET: "all", SPINE_MCP_WORKDIR: join(root, "work"), SPINE_BIN: join(root, "no-spine") } }));
const { tools } = await client.listTools();
let failed = 0;
async function call(name, args, check = () => true) {
  const started = Date.now(); const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = r.content.find(c => c.type === "text")?.text ?? ""; let value; try { value = JSON.parse(text); } catch { value = text; }
  const ok = !r.isError && check(value); if (!ok) failed++;
  console.log(`${ok ? "ok " : "ERR"} ${name.padEnd(26)} ${String(Date.now() - started).padStart(6)} ms${ok ? "" : `  ${text.slice(0, 260)}`}`); return value;
}
console.log(`${tools.length} tools listed`); if (tools.length !== 39) failed++;
await call("spine_doctor", {}, r => r.binaryFound === false);
await call("spine_status", { project }, r => typeof r.sha256 === "string");
await call("spine_inspect", { input: json }, r => JSON.stringify(r).includes("idle") && JSON.stringify(r).includes("think"));
await call("spine_validate", { input: json }, r => r.errors === 0);
await call("spine_measure", { input: json, animation: "think" });
await call("spine_timing", { input: json, animation: "think" });
await call("spine_compare_animations", { input: json, a: "idle", b: "think" });
await call("spine_mix_check", { input: json, runtime: "mecanim", transitions: [{ from: "idle", to: "think", mix: 0.25 }] }, r => r.tested === 1);
await call("spine_budget", { input: json });
await call("spine_rig_qa", { input: json });
await call("spine_skins", { input: json });
await call("spine_audit", { folder: dir }, r => JSON.stringify(r).includes("DFY"));
await client.close(); console.log(failed ? `${failed} failed` : "all ok"); process.exit(failed ? 1 : 0);
