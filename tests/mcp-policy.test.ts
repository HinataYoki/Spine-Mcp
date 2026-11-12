import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { loadConfig } from "../src/config.js";
import { boundResult, installToolPolicy, RESPONSE_CHARS } from "../src/tools/policy.js";
import { json } from "../src/tools/util.js";
import { registerTools } from "../src/tools/register.js";
import type { SpineCli } from "../src/spine/cli.js";

const dir = mkdtempSync(join(tmpdir(), "mcp-policy-"));
const config = { ...loadConfig(), workDir: dir };
afterAll(() => rmSync(dir, { recursive: true, force: true }));
async function connection(setup: (server: McpServer) => void) {
  const server = new McpServer({ name: "test", version: "1" });
  setup(server);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
describe("MCP context policy", () => {
  it("preserves small JSON and image blocks", () => {
    const result = json({ ok: true }, [{ type: "image", data: "AA==", mimeType: "image/png" }]);
    expect(boundResult(config, "tool", result)).toBe(result);
  });
  it("limits oversized output, keeps write outcome and stores full text", () => {
    const result = boundResult(config, "write", json({ mode: "applied", verification: { animationMatches: true }, keys: Array.from({ length: 5000 }, (_, time) => ({ time, value: 1 })) }));
    const text = result.content.find(c => c.type === "text")!.text;
    expect(text.length).toBeLessThanOrEqual(RESPONSE_CHARS);
    const data = JSON.parse(text);
    expect(data.truncated).toBe(true);
    expect(data.outcome.verification.animationMatches).toBe(true);
    expect(JSON.parse(readFileSync(data.file, "utf8")).keys).toHaveLength(5000);
    expect(result.content.some(c => c.type === "resource_link")).toBe(true);
  });
  it("exposes only selected tools and reads complete reports through standard resources", async () => {
    const long = "中".repeat(18000);
    const session = await connection(server => {
      installToolPolicy(server, config);
      server.registerTool("spine_inspect", { inputSchema: {}, annotations: { readOnlyHint: true } }, async () => json({ long }));
      server.registerTool("spine_export", { inputSchema: {} }, async () => json({}));
    });
    try {
      expect((await session.client.listTools()).tools.map(t => t.name)).toEqual(["spine_inspect"]);
      const result = await session.client.callTool({ name: "spine_inspect", arguments: {} });
      const data = JSON.parse(result.content.find(c => c.type === "text")!.text);
      let uri = data.report, text = "";
      while (uri) {
        const r = await session.client.readResource({ uri });
        const page = JSON.parse(r.contents[0]!.text as string);
        expect(page.text.length).toBeLessThanOrEqual(RESPONSE_CHARS);
        text += page.text; uri = page.next;
      }
      expect(JSON.parse(text)).toEqual({ long });
      await expect(session.client.readResource({ uri: "spine-report://invalid/0" })).rejects.toThrow();
    } finally { await session.close(); }
  });
  it("uses conservative write annotations and preserves all mode", async () => {
    const session = await connection(server => {
      installToolPolicy(server, config, "all");
      server.registerTool("spine_export", { inputSchema: {}, annotations: { readOnlyHint: false, destructiveHint: false } }, async () => json({}));
    });
    try { expect((await session.client.listTools()).tools[0]!.annotations?.destructiveHint).toBe(true); }
    finally { await session.close(); }
  });
  it("paginates exact timeline keys through real MCP", async () => {
    const session = await connection(server => {
      installToolPolicy(server, config);
      registerTools(server, config, {} as SpineCli);
    });
    try {
      const r = await session.client.callTool({ name: "spine_inspect", arguments: {
        input: join(process.cwd(), "tests", "fixtures", "mini.json"), view: "animation", animation: "idle", limit: 1, keyLimit: 1,
      } });
      expect(r.isError).not.toBe(true);
      const page = JSON.parse(r.content.find(c => c.type === "text")!.text);
      expect(page.timelines).toHaveLength(1);
      expect(page.timelines[0].keys).toHaveLength(1);
      expect(page.timelines[0].totalKeys).toBeGreaterThan(1);
      expect(page.nextOffset).toBe(1);
    } finally { await session.close(); }
  });
});
