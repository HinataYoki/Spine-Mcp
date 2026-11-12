// End-to-end write check over stdio on a throwaway copy of a project.
// Usage (outside the sandbox): npm run build && node scripts/smoke-write.mjs <project.spine> <sourceAnimation>
// Derives an exaggerated, slower variant, renders it, then restores the original from backup.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [source, animName] = process.argv.slice(2);
const root = mkdtempSync(join(tmpdir(), "spine-mcp-smoke-write-"));
cpSync(dirname(source), root, { recursive: true });
const project = join(root, basename(source));
const sha = () => createHash("sha256").update(readFileSync(project)).digest("hex").slice(0, 12);
console.log("copy:", project, "sha", sha());

const client = new Client({ name: "smoke-write", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, SPINE_MCP_WORKDIR: join(root, "work") } }));
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  const image = r.content.find((c) => c.type === "image");
  if (image) writeFileSync(join(process.cwd(), ".lab", "smoke", `write-${name}.png`), Buffer.from(image.data, "base64"));
  console.log(`\n## ${name} ${r.isError ? "ERROR" : "ok"}: ${text.slice(0, 700)}`);
  return r.isError ? text : JSON.parse(text);
}

const name = `${animName}-exaggerated`;
const ops = [{ op: "scaleValues", factor: 1.3, kinds: ["rotate"] }, { op: "retime", factor: 1.25 }];
await call("spine_derive_animation", { project, source: animName, name, ops });
console.log("sha after dry-run", sha());
const applied = await call("spine_derive_animation", { project, source: animName, name, ops, apply: true });
await call("spine_measure", { input: project, animation: name, limit: 3 });
console.log("sha after apply", sha());
await call("spine_render_frames", { project, animation: name, maxFrames: 6, scale: 30 });
const backups = await call("spine_list_backups", { project });
await call("spine_restore_backup", { project, backupId: applied.backup.id });
await call("spine_restore_backup", { project, backupId: applied.backup.id, apply: true });
console.log("sha after restore", sha(), "backups", backups.backups.length);
await client.close();
