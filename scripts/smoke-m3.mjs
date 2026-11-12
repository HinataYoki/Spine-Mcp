// M3 end-to-end check over stdio on a throwaway raptor copy: timing report, follow-through variant
// (offsets growing along the tail chain), loopFix + ease variant, A/B comparison with renders.
// Usage (outside the sandbox): npm run build && node scripts/smoke-m3.mjs <raptor-pro.spine>
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [source] = process.argv.slice(2);
const root = mkdtempSync(join(tmpdir(), "spine-mcp-m3-"));
cpSync(dirname(source), root, { recursive: true });
const project = join(root, basename(source));
const outDir = join(process.cwd(), ".lab", "smoke");
mkdirSync(outDir, { recursive: true });

const client = new Client({ name: "smoke-m3", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, SPINE_MCP_WORKDIR: join(root, "work") } }));
async function call(name, args, show = 600) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  r.content.filter((c) => c.type === "image").forEach((img, i) => writeFileSync(join(outDir, `m3-${name}-${i + 1}.png`), Buffer.from(img.data, "base64")));
  console.log(`\n## ${name} ${r.isError ? "ERROR" : "ok"} (${text.length} chars): ${text.slice(0, show)}`);
  if (r.isError) process.exitCode = 1;
  return r.isError ? null : JSON.parse(text);
}

const timing = await call("spine_timing", { input: project, animation: "walk" });
const inspect = await call("spine_inspect", { input: project, view: "bones" }, 0);
const tail = inspect.map((b) => b.name).filter((n) => /^tail\d+$/.test(n)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
console.log("tail chain:", tail.join(", "), "| pose intervals:", JSON.stringify(timing.poseIntervals));
const ops = tail.map((bone, i) => ({ op: "offsetBones", bones: [bone], seconds: +((i + 1) * 0.02).toFixed(3) }));
await call("spine_derive_animation", { project, source: "walk", name: "walk-follow", ops });
await call("spine_derive_animation", { project, source: "walk", name: "walk-follow", ops, apply: true }, 900);
await call("spine_derive_animation", { project, source: "roar", name: "roar-eased", ops: [{ op: "ease", easing: "easeInOutSine" }, { op: "loopFix" }], apply: true }, 400);
await call("spine_validate", { input: project, loopAnimations: ["walk", "walk-follow"] });
await call("spine_compare_animations", { input: project, a: "walk", b: "walk-follow", bones: tail, render: true }, 1200);
await client.close();
