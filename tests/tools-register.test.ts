// Every tool module loads and registers: a broken description string or schema fails here, not in a client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { SpineCli } from "../src/spine/cli.js";
import { registerAnalysisTools } from "../src/tools/analysis-tools.js";
import { registerEditorTools } from "../src/tools/editor-tools.js";
import { registerExportTools } from "../src/tools/export-tools.js";
import { registerQaTools } from "../src/tools/qa-tools.js";
import { registerTools } from "../src/tools/register.js";
import { registerReimportTools } from "../src/tools/reimport-tools.js";
import { registerWriteTools } from "../src/tools/write-tools.js";
import { registerAnimationEditTools } from "../src/tools/animation-edit-tools.js";
import { installToolPolicy } from "../src/tools/policy.js";

async function listTools(toolset?: string) {
  const server = new McpServer({ name: "t", version: "0" });
  const config = loadConfig(), cli = { available: false } as unknown as SpineCli;
  if (toolset) installToolPolicy(server, config, toolset);
  for (const r of [registerTools, registerWriteTools, registerAnimationEditTools, registerExportTools, registerAnalysisTools, registerReimportTools, registerEditorTools, registerQaTools]) r(server, config, cli);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), c.connect(b)]);
  try { return (await c.listTools()).tools; }
  finally { await c.close(); await server.close(); }
}

// Characters of each listTools entry (JSON): what a client pays to load a tool. Explanations go to docs/USAGE.md.
const BUDGET = { total: 63_600, perTool: 3_500, tools: { spine_generate_animation: 11_500, spine_derive_animation: 6_000 } as Record<string, number> };

describe("tool registration", () => {
  it("keeps the default animation toolset small", async () => {
    const tools = await listTools("animation");
    expect(tools).toHaveLength(15);
    expect(tools.reduce((n, t) => n + JSON.stringify(t).length, 0)).toBeLessThan(32_000);
  });
  it("offers a minimal core toolset without generator schemas", async () => {
    const tools = await listTools("core");
    expect(tools).toHaveLength(11);
    expect(tools.reduce((n, t) => n + JSON.stringify(t).length, 0)).toBeLessThan(12_000);
  });
  it("registers all 39 tools with their schemas", async () => {
    const tools = await listTools();
    expect(tools).toHaveLength(39);
    const gen = tools.find((t) => t.name === "spine_generate_animation")!;
    const walk = (gen.inputSchema.properties as Record<string, { properties?: Record<string, unknown> }>).walk!;
    expect(Object.keys(walk.properties!)).toEqual(expect.arrayContaining(["view", "sway", "arms", "legs"]));
    const props = (name: string) => Object.keys((tools.find((t) => t.name === name)!.inputSchema.properties ?? {}) as object);
    expect(props("spine_edit_animation")).toEqual(expect.arrayContaining(["source", "name", "edits", "apply", "replace", "editor"]));
    expect(props("spine_mix_check")).toEqual(expect.arrayContaining(["runtime", "eventThreshold", "trace"]));
    expect(props("spine_measure")).toContain("rootMotion");
    const validate = tools.find((t) => t.name === "spine_validate")!.inputSchema.properties as Record<string, { properties?: Record<string, unknown> }>;
    expect(Object.keys(validate.face!.properties!)).toEqual(expect.arrayContaining(["lids", "closedFrom", "eyes", "blink", "bones", "hide", "mouths", "mouthGroups", "fps"]));
    expect(props("spine_export")).toEqual(expect.arrayContaining(["sweep", "pot", "packing", "padding"]));
    expect(JSON.stringify(gen.inputSchema)).toContain('"gaze"');
    expect(Object.keys((gen.inputSchema.properties as Record<string, { properties?: Record<string, unknown> }>).blink!.properties!)).toEqual(expect.arrayContaining(["onPoses", "hide", "blinks", "closeTime"]));
    expect(props("spine_unity_check")).toEqual(expect.arrayContaining(["mecanimTransitions", "batching", "renderComponent", "tracks", "tracksSeconds"]));
    expect(props("spine_unity_import")).toEqual(expect.arrayContaining(["audit", "sources"]));
    expect(JSON.stringify(tools.find((t) => t.name === "spine_derive_animation")!.inputSchema)).toContain("setupKeys");
  });

  it("keeps tool schemas within their size budget", async () => {
    const sizes = (await listTools()).map((t) => ({ name: t.name, chars: JSON.stringify(t).length })).sort((x, y) => y.chars - x.chars);
    const total = sizes.reduce((n, s) => n + s.chars, 0);
    console.log([...sizes.map((s) => `${String(s.chars).padStart(6)}  ${s.name}`), `${String(total).padStart(6)}  total`].join("\n"));
    expect(total).toBeLessThanOrEqual(BUDGET.total);
    for (const s of sizes) expect(s.chars, s.name).toBeLessThanOrEqual(BUDGET.tools[s.name] ?? BUDGET.perTool);
  });
});
