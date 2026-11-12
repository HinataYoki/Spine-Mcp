import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpError, ErrorCode, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { pruneDir } from "../spine/project.js";

export const RESPONSE_CHARS = 8_000;
export const ANIMATION_TOOLS = new Set([
  "spine_doctor", "spine_status", "spine_editor_status", "spine_project_info", "spine_export_json",
  "spine_inspect", "spine_validate", "spine_measure", "spine_render_frames",
  "spine_add_animation", "spine_edit_animation", "spine_derive_animation", "spine_generate_animation",
  "spine_list_backups", "spine_restore_backup",
]);
export const CORE_TOOLS = new Set([...ANIMATION_TOOLS].filter(name => ![
  "spine_generate_animation", "spine_derive_animation", "spine_measure", "spine_export_json",
].includes(name)));

function preview(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  if (!value || typeof value !== "object") return value;
  if (depth >= 5) return Array.isArray(value) ? { count: value.length } : { fields: Object.keys(value).length };
  if (Array.isArray(value)) return value.length > 5
    ? { total: value.length, shown: value.slice(0, 5).map(v => preview(v, depth + 1)) }
    : value.map(v => preview(v, depth + 1));
  return Object.fromEntries(Object.entries(value).slice(0, 35).map(([k, v]) => [k, preview(v, depth + 1)]));
}

/** Keep wire-compatible small results; preserve oversized text outside the model context. */
export function boundResult(config: Config, tool: string, result: CallToolResult): CallToolResult {
  const texts = result.content.filter(c => c.type === "text");
  if (texts.reduce((n, c) => n + c.text.length, 0) <= RESPONSE_CHARS) return result;
  const original = texts.length === 1 ? texts[0]!.text : JSON.stringify(texts.map(c => c.text));
  const id = createHash("sha256").update(original).digest("hex");
  const dir = join(config.workDir, "reports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) { pruneDir(dir, 39, /^[a-f0-9]{64}\.json$/); writeFileSync(file, original); }
  let parsed: unknown;
  try { parsed = JSON.parse(original); } catch { parsed = original; }
  const summary = preview(parsed);
  const envelope: Record<string, unknown> = {
    truncated: true, tool, totalChars: original.length, report: `spine-report://${id}/0`, file,
    hint: "Summary only. Read report resource pages when needed; local file contains full text.",
    summary,
  };
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const source = parsed as Record<string, unknown>;
    envelope.outcome = Object.fromEntries(["mode", "project", "name", "backup", "verification", "staged", "errors", "warnings"]
      .filter(k => Object.hasOwn(source, k)).map(k => [k, preview(source[k])]));
  }
  if (JSON.stringify(envelope).length > RESPONSE_CHARS) envelope.summary = "Result too large for inline preview; read report.";
  if (JSON.stringify(envelope).length > RESPONSE_CHARS) envelope.outcome = "Read full report for complete write outcome.";
  return {
    ...result,
    content: [
      { type: "text", text: JSON.stringify(envelope) },
      ...result.content.filter(c => c.type !== "text"),
      { type: "resource_link", uri: `spine-report://${id}/0`, name: `${tool} report`, mimeType: "application/json" },
    ],
  };
}

type Handler = (args: Record<string, unknown>, extra: unknown) => CallToolResult | Promise<CallToolResult>;
type Register = (name: string, definition: { inputSchema?: z.ZodRawShape; annotations?: Record<string, unknown> }, callback: Handler) => unknown;

/** One boundary for tool visibility and response budgets, independent of profile defaults. */
export function installToolPolicy(server: McpServer, config: Config, toolset: string = "animation") {
  if (!["core", "animation", "all"].includes(toolset)) throw new Error("SPINE_MCP_TOOLSET must be core, animation or all.");
  const target = server as unknown as { registerTool: Register };
  const register = target.registerTool.bind(server);
  target.registerTool = (name, definition, callback) => {
    if (toolset === "animation" && !ANIMATION_TOOLS.has(name)) return undefined;
    if (toolset === "core" && !CORE_TOOLS.has(name)) return undefined;
    const annotations = { ...definition.annotations };
    // These tools can replace existing data when explicitly requested. Backups do not make them non-destructive.
    if (!annotations.readOnlyHint) annotations.destructiveHint = true;
    return register(name, { ...definition, annotations }, async (args, extra) => boundResult(config, name, await callback(args, extra)));
  };
  server.registerResource("spine-report", new ResourceTemplate("spine-report://{id}/{offset}", { list: undefined }), {
    description: "Full tool report, 8000-character pages. Follow next URI; reports are limited to the latest 40 files.",
    mimeType: "application/json",
  }, async (uri, vars) => {
    const id = String(vars.id), offsetText = String(vars.offset);
    if (!/^[a-f0-9]{64}$/.test(id) || !/^\d{1,12}$/.test(offsetText)) throw new McpError(ErrorCode.InvalidParams, "Invalid report URI.");
    const file = join(config.workDir, "reports", `${id}.json`);
    if (!existsSync(file)) throw new McpError(ErrorCode.InvalidParams, "Report expired or not found; run the tool again.");
    const text = readFileSync(file, "utf8"), offset = Number(offsetText);
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({
      offset, totalChars: text.length, text: text.slice(offset, offset + RESPONSE_CHARS),
      next: offset + RESPONSE_CHARS < text.length ? `spine-report://${id}/${offset + RESPONSE_CHARS}` : null,
    }) }] };
  });
  return server;
}
