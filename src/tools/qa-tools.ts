import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import { auditFolder } from "../spine/audit.js";
import type { SpineCli } from "../spine/cli.js";
import { loadProject, pickSkeleton, UserError } from "../spine/project.js";
import { rigQa } from "../spine/rigqa.js";
import { loadSkeletonData, spine } from "../spine/runtime.js";
import { skinReport } from "../spine/skins.js";
import { skinSheet } from "../spine/web.js";
import type { SkeletonJson } from "../spine/types.js";
import { atlasFor } from "./analysis-tools.js";
import { budgetLimits, guarded, json } from "./util.js";

const inputPath = z.string().describe(".spine, .json or .skel(.bytes)");
const limits = budgetLimits.optional().describe("Device budget for pass/fail");

export function registerQaTools(server: McpServer, config: Config, cli: SpineCli) {
  server.registerTool("spine_rig_qa", {
    title: "Rig QA",
    description: [
      "Rig hygiene: names (spaces, clashes, default names, mixed left/right styles), unused bones, attachments, slots and events, bad setup scale, weights not summing to 1, too many influences, weights that fold when a bone turns, joints that open, art a mesh cuts off, missing or unused images. Complements spine_validate.",
    ].join(" "),
    inputSchema: {
      input: inputPath, skeleton: z.string().optional(),
      maxInfluences: z.number().int().min(1).max(16).optional(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ input, skeleton, maxInfluences }) => {
    const loaded = await loadProject(config, cli, input);
    const list = skeleton ? [pickSkeleton(loaded, skeleton)] : loaded.skeletons;
    return json({
      skeletons: list.map((s) => ({ name: s.name, ...rigQa(s.doc, { baseDir: dirname(input), maxInfluences, otherSkeletons: loaded.skeletons.filter((k) => k !== s).map((k) => k.doc) }) })),
    });
  }));

  server.registerTool("spine_skins", {
    title: "Skin and skin combination check",
    description: [
      "Checks each skin, or mix-and-match combinations: attachment counts, slots several skins set (last wins), slots none fills, and each one's budget over every frame. atlas or pack for exact draw calls.",
    ].join(" "),
    inputSchema: {
      input: inputPath, skeleton: z.string().optional(),
      combinations: z.array(z.array(z.string()).min(1)).max(200).optional().describe("Skin lists, in order"),
      atlas: z.string().optional(), pack: z.boolean().optional(),
      animations: z.boolean().optional().describe("false: setup pose only"),
      fps: z.number().int().min(5).max(60).optional(),
      limits,
      render: z.boolean().optional().describe("Draw them side by side (Chrome)"),
      renderAnimation: z.string().optional(),
      renderTime: z.number().min(0).optional(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ input, skeleton, combinations, atlas, pack, animations, fps, limits: lim, render, renderAnimation, renderTime }) => {
    const s = pickSkeleton(await loadProject(config, cli, input), skeleton);
    const atlasText = await atlasFor(config, cli, input, atlas, pack);
    const data = atlasText
      ? new spine.SkeletonJson(new spine.AtlasAttachmentLoader(new spine.TextureAtlas(atlasText))).readSkeletonData(s.doc as SkeletonJson)
      : loadSkeletonData(s.doc);
    let report;
    try {
      report = skinReport(s.doc, data, { combinations, fps, limits: lim, pagesKnown: !!atlasText, animations });
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    if (!render) return json({ name: s.name, ...report });
    if (!input.endsWith(".spine")) throw new UserError("render needs a .spine project");
    const combos = report.rows.map((r) => r.skins).slice(0, 16);
    const sheet = await skinSheet(config, cli, { project: input, skeleton: s.name, combinations: combos, animation: renderAnimation, time: renderTime });
    report.notes.push(...sheet.notes, ...(report.rows.length > 16 ? [`Rendered the first 16 of ${report.rows.length} combinations.`] : []));
    return json({ name: s.name, ...report }, [{ type: "image", data: sheet.png.toString("base64"), mimeType: "image/png" }]);
  }));

  server.registerTool("spine_audit", {
    title: "Audit a folder of Spine projects",
    description: [
      "Validate, rig QA and budget on every .spine and skeleton .json under a folder: one ok/fail row per skeleton (strict: validation warnings fail too). For release checks and CI.",
    ].join(" "),
    inputSchema: {
      folder: z.string(),
      limits, strict: z.boolean().optional(),
      max: z.number().int().min(1).max(500).optional(),
      onlyFailed: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ folder, limits: lim, strict, max, onlyFailed }) => {
    if (!isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory()) throw new UserError(`Not an absolute path to a folder: ${folder}`);
    const r = await auditFolder(config, cli, folder, { limits: lim, strict, max });
    const only = onlyFailed ?? r.rows.length > 40;
    return json({ ...r, rows: only ? r.rows.filter((x) => !x.ok) : r.rows, ...(only ? { passedRowsHidden: r.rows.filter((x) => x.ok).length } : {}) });
  }));
}
