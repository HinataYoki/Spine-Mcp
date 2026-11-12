import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import type { SpineCli } from "../spine/cli.js";
import { budgetReport } from "../spine/budget.js";
import { exportRuntime } from "../spine/export.js";
import { mixCheck } from "../spine/mix.js";
import { loadProject, pickSkeleton, UserError } from "../spine/project.js";
import { loadSkeletonData, spine } from "../spine/runtime.js";
import type { SkeletonJson } from "../spine/types.js";
import { budgetLimits, guarded, json } from "./util.js";

const inputPath = z.string().describe(".spine, .json or .skel(.bytes)");
const skeletonName = z.string().optional().describe("Needed only with several skeletons");

export function registerAnalysisTools(server: McpServer, config: Config, cli: SpineCli) {
  server.registerTool("spine_mix_check", {
    title: "Check animation transitions for pops",
    description: [
      "Plays transitions with spine-core's AnimationState like a game (mixes, optional base track), switching at several points; reports pops with phase and likely cause, timelines first keyed after 0, and events lost inside the mix.",
      "runtime mecanim: as spine-unity's SkeletonMecanim, plus the keys each incoming animation needs (setupKeys).",
    ].join(" "),
    inputSchema: {
      input: inputPath, skeleton: skeletonName,
      transitions: z.array(z.object({ from: z.string(), to: z.string(), mix: z.number().min(0).max(5).optional() })).optional()
        .describe("Default: every pair, up to limit"),
      defaultMix: z.number().min(0).max(5).optional(),
      track: z.number().int().min(0).max(8).optional(),
      base: z.string().optional().describe("Loops on track 0 (track >= 1)"),
      at: z.array(z.number().min(0).max(1)).optional().describe("Switch points, share of outgoing"),
      fps: z.number().int().min(15).max(240).optional(),
      bones: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(500).optional(),
      trace: z.string().optional().describe("Bone traced per frame"),
      eventThreshold: z.number().min(0).max(1).optional(),
      runtime: z.enum(["animationState", "mecanim"]).optional(),
      mecanimMode: z.enum(["mixNext", "alwaysMix", "hard", "match"]).optional(),
      autoReset: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ input, skeleton, ...o }) => {
    const s = pickSkeleton(await loadProject(config, cli, input), skeleton);
    let r;
    try {
      r = mixCheck(loadSkeletonData(s.doc), s.doc.animations ?? {}, o);
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    const failing = r.transitions.filter((t) => !t.ok);
    return json({
      skeleton: s.name, fps: r.fps, track: r.track, base: r.base, tested: r.tested, failing: r.failing,
      ok: r.transitions.filter((t) => t.ok).map((t) => `${t.from}->${t.to}`).slice(0, 60),
      // Worst pop per failing transition (each switch point reports one): keeps large rigs under the response budget.
      pops: failing.filter((t) => t.pops.length).slice(0, 40).map((t) => {
        const worst = [...t.pops].sort((x, y) => y.step / Math.max(y.neighbours, 1e-6) - x.step / Math.max(x.neighbours, 1e-6))[0]!;
        return { from: t.from, to: t.to, mix: t.mix, switchPointsWithPops: t.pops.length, worst };
      }),
      ...(failing.some((t) => t.held?.length) ? { held: failing.filter((t) => t.held?.length).slice(0, 40).map((t) => ({ from: t.from, to: t.to, mix: t.mix, bones: t.held!.slice(0, 6) })) } : {}),
      ...(o.trace ? { traces: r.transitions.filter((t) => t.trace).slice(0, 12).map((t) => ({ from: t.from, to: t.to, mix: t.mix, ...t.trace })) } : {}),
      lostEvents: r.transitions.filter((t) => t.lostEvents.length).slice(0, 40).map((t) => ({ from: t.from, to: t.to, mix: t.mix, events: t.lostEvents.slice(0, 8) })),
      runtime: r.runtime, ...(r.mecanimMissingKeys ? { mecanimMissingKeys: r.mecanimMissingKeys.slice(0, 40) } : {}),
      layeredPops: r.layeredPops, lateFirstKeys: r.lateFirstKeys.slice(0, 25), lateFirstKeysTotal: r.lateFirstKeys.length, notes: r.notes,
    });
  }));

  server.registerTool("spine_budget", {
    title: "Performance budget",
    description: [
      "Spine Metrics over the setup pose and every frame: attachments, vertices, vertex transforms, triangles, area, clipping, draw call estimate, timelines, constraint costs; worst values with animation@time.",
      "limits for pass/fail; draw calls need atlas or pack (~4 s).",
    ].join(" "),
    inputSchema: {
      input: inputPath, skeleton: skeletonName,
      atlas: z.string().optional(),
      pack: z.boolean().optional().describe("Temporary atlas (projects)"),
      skin: z.string().optional(),
      fps: z.number().int().min(5).max(120).optional(),
      limits: budgetLimits.optional(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ input, skeleton, atlas, pack, skin, fps, limits }) => {
    const s = pickSkeleton(await loadProject(config, cli, input), skeleton);
    const atlasText = await atlasFor(config, cli, input, atlas, pack);
    const data = atlasText
      ? new spine.SkeletonJson(new spine.AtlasAttachmentLoader(new spine.TextureAtlas(atlasText))).readSkeletonData(s.doc as SkeletonJson)
      : loadSkeletonData(s.doc);
    try {
      return json({ name: s.name, ...budgetReport(data, s.doc.animations ?? {}, { fps, limits, pagesKnown: !!atlasText, skin }) });
    } catch (e) {
      throw new UserError((e as Error).message);
    }
  }));
}

/** Atlas text for exact draw calls: a given .atlas, or one packed from the project's images with the Spine CLI. */
export async function atlasFor(config: Config, cli: SpineCli, input: string, atlas?: string, pack?: boolean): Promise<string | null> {
  if (atlas) return readFileSync(atlas, "utf8");
  if (!pack) return null;
  if (!input.endsWith(".spine")) throw new UserError("pack needs a .spine project (or pass atlas)");
  mkdirSync(config.workDir, { recursive: true });
  const tmp = mkdtempSync(join(config.workDir, "budget-"));
  try {
    const ex = await exportRuntime(config, cli, { project: input, outputDir: tmp, format: "json" });
    const name = ex.files.find((f) => f.name.endsWith(".atlas") && !f.name.includes("@"))?.name;
    return name ? readFileSync(join(tmp, name), "utf8") : null;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
