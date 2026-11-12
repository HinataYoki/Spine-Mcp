import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { UserError } from "../spine/project.js";

export const whole = (min = 0, max = 1e9) => z.number().int().min(min).max(max);

export const budgetLimits = z.object({
  bones: whole().optional(), constraints: whole().optional(), vertexTransforms: whole().optional(),
  vertices: whole().optional(), drawCalls: whole().optional(), clippedTriangles: whole().optional(), area: z.number().optional(),
});

export const pixelRect = z.object({ x: whole(), y: whole(), width: whole(1), height: whole(1) });

/** Tool output budget: MCP clients warn/truncate around 10k–25k tokens. */
export const MAX_CHARS = 24_000;

/** Compact JSON (pretty-printing costs ~30% more tokens). */
export function json(value: unknown, extra: CallToolResult["content"] = []): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }, ...extra] };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Wraps a tool handler: expected problems become readable tool errors instead of protocol errors. */
export function guarded<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      const err = e as Error;
      return fail(err instanceof UserError ? err.message : `${err.name}: ${err.message}`);
    }
  };
}
