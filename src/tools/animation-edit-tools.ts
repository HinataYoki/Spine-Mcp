import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import type { SpineCli } from "../spine/cli.js";
import { editAnimation, type KeyframeEdit } from "../spine/keyframes.js";
import { loadProject, pickSkeleton, UserError } from "../spine/project.js";
import { addAnimation } from "../spine/write.js";
import { guarded, json } from "./util.js";

export function registerAnimationEditTools(server: McpServer, config: Config, cli: SpineCli) {
  server.registerTool("spine_edit_animation", {
    title: "Copy and edit animation keyframes",
    description: "Copies source to name, edits timelines in order, then uses backed-up CLI import and readback verification. Dry-run by default. edits:[] duplicates. path is JSON segments, e.g. ['bones','head','rotate']; times are seconds. set replaces whole keys at matching times. easing is normalized; raw key.curve is absolute Spine 4.3. See docs/USAGE.md#keyframe-editing.",
    inputSchema: {
      project: z.string(), skeleton: z.string().optional(), source: z.string(), name: z.string(),
      edits: z.array(z.object({
        op: z.enum(["set", "delete"]), path: z.array(z.string()).min(1).max(5),
        keys: z.array(z.record(z.string(), z.unknown())).optional(),
        mode: z.enum(["upsert", "append", "replace"]).optional(),
        times: z.array(z.number().nonnegative()).optional(),
        easing: z.union([z.string(), z.array(z.number())]).optional(),
      })),
      apply: z.boolean().optional(), replace: z.boolean().optional(),
      loopAnimations: z.array(z.string()).optional(),
      editor: z.enum(["auto", "staging", "inPlace"]).optional(),
      stagingPath: z.string().optional(), allowUpgrade: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, guarded(async ({ source, edits, ...args }) => {
    const s = pickSkeleton(await loadProject(config, cli, args.project), args.skeleton);
    if (!Object.hasOwn(s.doc.animations ?? {}, source)) throw new UserError(`Animation "${source}" not found.`);
    const animation = editAnimation(s.doc.animations![source]!, edits as KeyframeEdit[]);
    return json(await addAnimation(config, cli, { ...args, animation, trace: { tool: "spine_edit_animation", detail: `${source}: ${edits.length} edits` } }));
  }));
}
