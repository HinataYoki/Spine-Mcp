import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = resolve(import.meta.dirname, "..");
const dir = join(repo, ".lab", `keyframes-${Date.now()}`);
mkdirSync(dir, { recursive: true });
const original = join(repo, "DFY", "DFY.spine");
const project = join(dir, "DFY_KEYFRAME_TEST.spine");
const hash = p => createHash("sha256").update(readFileSync(p)).digest("hex");
const beforeHash = hash(original);
copyFileSync(original, project);
const client = new Client({ name: "keyframe-edit-verification", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath, args: [join(repo, "dist", "index.js")], stderr: "pipe",
  env: { ...process.env, SPINE_MCP_TOOLSET: "all", SPINE_BIN: "C:\\Program Files\\Spine\\Spine.com", SPINE_VERSION: "4.3.26", SPINE_MCP_WORKDIR: join(dir, "cache") },
});
const results = [];
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 39);
  async function call(name, args) {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    const text = r.content.find(c => c.type === "text")?.text ?? "";
    assert.ok(!r.isError, `${name}: ${text}`);
    const value = JSON.parse(text);
    results.push({ tool: name, result: value });
    return value;
  }
  const common = { project, skeleton: "DFY", source: "idle", name: "ai_head_daze", editor: "inPlace" };
  const edits = [{ op: "set", path: ["bones", "头", "rotate"], mode: "replace", easing: "ease-in-out", keys: [{ time: 0, value: 0 }, { time: 0.5, value: -5 }, { time: 1, value: 0 }] }];
  const dry = await call("spine_edit_animation", { ...common, edits });
  assert.equal(dry.mode, "dry-run");
  const written = await call("spine_edit_animation", { ...common, edits, apply: true });
  for (const result of [written,
    await call("spine_edit_animation", { ...common, source: "ai_head_daze", name: "ai_head_daze_copy", edits: [], apply: true }),
    await call("spine_edit_animation", { ...common, source: "ai_head_daze", name: "ai_head_daze_less", edits: [{ op: "delete", path: ["bones", "头", "rotate"], times: [0.5] }], apply: true }),
  ]) {
    assert.equal(result.mode, "applied");
    assert.ok(result.backup);
    assert.deepEqual(result.verification, { animationMatches: true, otherAnimationsUnchanged: true, structureUnchanged: true, differences: [] });
  }
  await call("spine_project_info", { paths: [project] });
  const exported = await call("spine_export_json", { project });
  const exportedText = JSON.stringify(exported);
  assert.ok(exportedText.includes("DFY"));
  assert.equal(hash(original), beforeHash);
  writeFileSync(join(dir, "results.json"), JSON.stringify({ original, beforeHash, originalUnchanged: true, project, results }, null, 2));
  console.log(JSON.stringify({ project, tools: tools.length, originalUnchanged: true, verifiedWrites: 3, results: join(dir, "results.json") }, null, 2));
} finally {
  await client.close();
}
