import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = resolve(import.meta.dirname, ".."), dir = join(repo, ".lab", "mcp-audit");
mkdirSync(dir, { recursive: true });
const input = join(dir, "synthetic.json");
writeFileSync(input, JSON.stringify({ skeleton: { spine: "4.3.26" }, bones: [{ name: "root" }], animations: {
  test: { bones: { root: { rotate: Array.from({ length: 1200 }, (_, i) => ({ time: i / 30, value: i % 10 })) } } },
} }));
const rows = [];
for (const toolset of ["core", "animation", "all"]) {
  const client = new Client({ name: "mcp-audit", version: "1" });
  const started = performance.now();
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(repo, "dist", "index.js")], stderr: "pipe",
    env: { ...process.env, SPINE_MCP_TOOLSET: toolset, SPINE_MCP_WORKDIR: join(dir, "cache") } });
  try {
    await client.connect(transport);
    const initializationMs = performance.now() - started;
    const { tools } = await client.listTools();
    assert.equal(tools.length, toolset === "all" ? 39 : toolset === "core" ? 11 : 15);
    const schemaChars = tools.reduce((n, t) => n + JSON.stringify(t).length, 0);
    const latencies = [];
    let maxTextChars = 0;
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      const result = await client.callTool({ name: "spine_inspect", arguments: {
        input, view: "animation", animation: "test", keyLimit: 200, keyOffset: i % 6 * 200,
      } });
      assert.ok(!result.isError);
      latencies.push(performance.now() - t);
      const text = result.content.filter(c => c.type === "text").map(c => c.text).join("");
      maxTextChars = Math.max(maxTextChars, text.length);
      assert.ok(text.length <= 8000);
    }
    latencies.sort((a, b) => a - b);
    rows.push({ toolset, tools: tools.length, schemaChars, initializationMs: +initializationMs.toFixed(1),
      inspectMedianMs: +latencies[10].toFixed(2), inspectP95Ms: +latencies[18].toFixed(2), maxTextChars });
    writeFileSync(join(repo, "docs", toolset === "all" ? "TOOL_SCHEMAS.json" : `TOOL_SCHEMAS_${toolset.toUpperCase()}.json`), JSON.stringify({ "说明": "工具参数参考。以客户端 tools/list 为准。", toolset, "工具数量": tools.length, tools }, null, 2) + "\n");
  } finally { await client.close(); }
}
writeFileSync(join(dir, "metrics.json"), JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows, null, 2));
