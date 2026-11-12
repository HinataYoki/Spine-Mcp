import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { fail } from "./util.js";

export const PROFILE_AWARE = new Set(["spine_export", "spine_unity_import", "spine_unity_check"]);

type Handler = (args: Record<string, unknown>, extra: unknown) => unknown;
type Register = (name: string, def: { inputSchema?: z.ZodRawShape }, cb: Handler) => unknown;

export function profileDefaults(server: McpServer, config: Config): McpServer {
  const tools = config.profile?.tools ?? {};
  if (!Object.keys(tools).length) return server;
  const target = server as unknown as { registerTool: Register };
  const register = target.registerTool.bind(server);
  target.registerTool = (name, def, cb) => {
    const defaults = tools[name];
    if (!defaults || PROFILE_AWARE.has(name) || !def.inputSchema) return register(name, def, cb);
    const schema = z.object(def.inputSchema).partial().strict();
    return register(name, def, (args, extra) => {
      const missing = Object.fromEntries(Object.entries(defaults).filter(([k]) => args[k] === undefined));
      const parsed = schema.safeParse(missing);
      if (!parsed.success) return fail(`SPINE_MCP_PROFILE tools.${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`);
      return cb({ ...args, ...(parsed.data as Record<string, unknown>) }, extra);
    });
  };
  return server;
}
