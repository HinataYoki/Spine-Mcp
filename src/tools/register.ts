import { execFileSync, windowsSetupWarnings } from "../platform.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rootMotionReport } from "../spine/rootmotion.js";
import type { Config } from "../config.js";
import { cliFailed, type SpineCli } from "../spine/cli.js";
import { editorStatus } from "../spine/editor.js";
import { faceAudit } from "../spine/faceaudit.js";
import { parseProjectInfo } from "../spine/info.js";
import { animationDetail, summarizeSkeleton } from "../spine/inspect.js";
import { measureMotion } from "../spine/measure.js";
import { assertInputPath, loadProject, pickSkeleton, UserError } from "../spine/project.js";
import { contactSheet, projectImagesDir, renderFrames } from "../spine/render.js";
import { folderImages } from "../spine/gaps.js";
import { loadSkeletonData } from "../spine/runtime.js";
import { partTravel } from "../spine/travel.js";
import { sampleAnimation } from "../spine/sample.js";
import { compareMotion } from "../spine/compare-motion.js";
import { timingReport } from "../spine/timing.js";
import { issueCounts, validateSkeleton } from "../spine/validate.js";
import { guarded, json, MAX_CHARS } from "./util.js";

const inputPath = z.string().describe(".spine, .json or .skel(.bytes)");
const skeletonName = z.string().optional().describe("Needed only with several skeletons");

function hasBinary(bin: string): boolean {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function runtimeVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("@esotericsoftware/spine-core/package.json");
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

/** Editor versions the conformance suite has a saved baseline for (research/conformance/baseline-<v>.json). */
function conformanceBaselines(): string[] {
  const dir = fileURLToPath(new URL("../../research/conformance/", import.meta.url));
  return existsSync(dir) ? readdirSync(dir).map((f) => /^baseline-(.+)\.json$/.exec(f)?.[1]).filter((v): v is string => !!v).sort() : [];
}

/** Raw section view with an optional name filter; falls back to a name list when too large for one response. */
function capped(view: string, entries: { name: string }[], filter?: string, offset = 0, limit = 50) {
  const list = filter ? entries.filter((e) => e.name.includes(filter)) : entries;
  return json({ view, total: list.length, offset, entries: list.slice(offset, offset + limit),
    nextOffset: offset + limit < list.length ? offset + limit : null });
}

export function registerTools(server: McpServer, config: Config, cli: SpineCli) {
  server.registerTool("spine_doctor", {
    title: "Check Spine setup",
    description: "Checks the Spine CLI, editor version and license, spine-core version and work folder. Run first when something fails.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, guarded(async () => {
    const r = await cli.run(["--version"], { pin: false, timeoutMs: 60_000 });
    const editor = r.raw.match(/Spine (\d+\.\d+\.\d+(?:-\w+)?) (Professional|Essential|Trial)?/);
    const launcher = r.raw.match(/Spine Launcher (\S+)/)?.[1] ?? null;
    const runtime = runtimeVersion();
    const mm = (v: string | null | undefined) => v?.split(".").slice(0, 2).join(".");
    const warnings: string[] = [];
    if (editor?.[1] && config.spineVersion && editor[1] !== config.spineVersion) {
      warnings.push(`Spine ${editor[1]} is the editor Spine starts by default, but spine-mcp pins ${config.spineVersion} (SPINE_VERSION): exports, renders and writes use ${config.spineVersion}. Set SPINE_VERSION=${editor[1]} to move${mm(editor[1]) !== mm(config.spineVersion) ? " (a different major.minor also needs a matching spine-core)" : ""}.`);
    }
    const verified = conformanceBaselines();
    for (const v of new Set([editor?.[1], config.spineVersion].filter((x): x is string => !!x))) {
      if (!verified.includes(v)) warnings.push(`Spine ${v} has not been checked by the conformance suite yet: run node scripts/conformance.mjs --version ${v} (outside the sandbox) and read what changed before relying on it.`);
    }
    if (config.spineVersion && runtime !== "unknown" && mm(runtime) !== mm(config.spineVersion)) warnings.push(`spine-core ${runtime} does not match the pinned editor ${config.spineVersion} (major.minor must match).`);
    warnings.push(...windowsSetupWarnings(config.workDir, config.spineBin));
    return json({
      launcherVersion: launcher, warnings,
      spineBin: config.spineBin, binaryFound: cli.available, pinnedVersion: config.spineVersion || null,
      editorVersion: editor?.[1] ?? null, edition: editor?.[2] ?? null, licensed: /Licensed to/.test(r.raw),
      runtime: `spine-core ${runtime}`, workDir: config.workDir, conformanceVerified: verified,
      editorWindowOpen: (() => { const e = editorStatus(config.spineBin); return e.unknown ? "unknown" : e.running; })(),
      mediaTools: Object.fromEntries(["magick", "img2webp", "ffmpeg"].map((bin) => [bin, hasBinary(bin)])),
      cli: { exitCode: r.exitCode, seconds: r.seconds, errors: r.errors },
      notes: [
        "Runtime major.minor must match the editor that exported the data.",
        "Projects saved by an older Spine are read fine; writing one saves it in the pinned version's format, so writes to an older major.minor need allowUpgrade.",
        "Trial edition cannot export; .json inputs still work for inspect/validate/measure.",
        "spine_showcase needs magick, plus img2webp (.webp) or ffmpeg (.gif, .mp4).",
        "CLI calls run beside an open editor; while one is open, writes go to a verified staging copy (see spine_editor_status).",
      ],
    });
  }));

  server.registerTool("spine_project_info", {
    title: "Spine project info",
    description: "Fast CLI summary (`Spine -i`): editor version, FPS, skeletons, bone/slot/constraint/animation lists. Several paths per call (one ~3 s CLI start).",
    inputSchema: { paths: z.array(inputPath).min(1) },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ paths }) => {
    for (const p of paths) assertInputPath(p, [".spine", ".json"]);
    const r = await cli.run(paths.flatMap((p) => ["-i", p]));
    if (cliFailed(r)) throw new UserError(`Spine info failed: ${[...r.errors, ...r.lines.slice(-3)].join(" | ")}`);
    return json({ projects: parseProjectInfo(r.lines), warnings: r.warnings, seconds: r.seconds });
  }));

  server.registerTool("spine_export_json", {
    title: "Export project to JSON",
    description: "Exports a .spine project's skeletons to JSON in the cache folder (never next to the project); re-exports only when the project changed.",
    inputSchema: { project: z.string(), refresh: z.boolean().optional() },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ project, refresh }) => {
    assertInputPath(project, [".spine"]);
    const res = await loadProject(config, cli, project, { refresh });
    return json({
      cached: res.cached, seconds: res.export?.seconds ?? 0, warnings: res.export?.warnings ?? [],
      skeletons: res.skeletons.map((s) => ({ name: s.name, json: s.jsonPath, spine: s.doc.skeleton.spine })),
    });
  }));

  server.registerTool("spine_inspect", {
    title: "Inspect skeleton",
    description: "Skeleton structure. view summary (default): counts, bone tree, constraints, per-animation stats; bones|slots|skins|constraints: raw section JSON; animation: every timeline with exact keys.",
    inputSchema: {
      input: inputPath, skeleton: skeletonName,
      view: z.enum(["summary", "bones", "slots", "skins", "constraints", "animation"]).optional(),
      animation: z.string().optional(),
      owner: z.string().optional().describe("view=animation: owner name contains"),
      kind: z.string().optional().describe("view=animation: kind contains, e.g. bone.rotate"),
      filter: z.string().optional().describe("Section views: name contains"),
      offset: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(100).optional().describe("Entries/timelines per page (default 50)"),
      keyOffset: z.number().int().nonnegative().optional(),
      keyLimit: z.number().int().min(1).max(200).optional().describe("Keys per timeline (default 100)"),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ input, skeleton, view = "summary", animation, owner, kind, filter, offset = 0, limit = 50, keyOffset = 0, keyLimit = 100 }) => {
    const res = await loadProject(config, cli, input);
    const s = pickSkeleton(res, skeleton);
    const doc = s.doc;
    switch (view) {
      case "summary": {
        // Binary data: its own version, and the CLI version its JSON export carries when they differ.
        const v = res.sourceVersion && res.sourceVersion !== doc.skeleton.spine ? { spineVersion: res.sourceVersion, exportedBy: doc.skeleton.spine } : {};
        return json({ source: s.jsonPath, skeletons: res.skeletons.map((k) => k.name), ...summarizeSkeleton(s.name, doc), ...v });
      }
      case "bones": return capped(view, doc.bones, filter, offset, limit);
      case "slots": return capped(view, doc.slots ?? [], filter, offset, limit);
      case "skins": return capped(view, doc.skins ?? [], filter, offset, limit);
      case "constraints": return capped(view, doc.constraints ?? [], filter, offset, limit);
      case "animation": {
        if (!animation) throw new UserError("view=animation needs `animation`");
        const a = doc.animations?.[animation];
        if (!a) throw new UserError(`Animation "${animation}" not found. Available: ${Object.keys(doc.animations ?? {}).join(", ")}`);
        const timelines = animationDetail(a).filter((t) => (!owner || t.owner.includes(owner)) && (!kind || t.kind.includes(kind)));
        return json({
          animation, total: timelines.length, offset,
          nextOffset: offset + limit < timelines.length ? offset + limit : null,
          timelines: timelines.slice(offset, offset + limit).map(t => ({ ...t,
            totalKeys: t.keys.length, keyOffset, nextKeyOffset: keyOffset + keyLimit < t.keys.length ? keyOffset + keyLimit : null,
            keys: t.keys.slice(keyOffset, keyOffset + keyLimit),
          })),
        });
      }
    }
  }));

  server.registerTool("spine_validate", {
    title: "Validate skeleton",
    description: "Finds problems: duplicate names, bone order, missing references (Spine drops them on import), mesh indices, key order, curves, keys on physics bones; samples every animation in spine-core (NaN, loop seams, clamps, invisible keys, mesh folds, joints opening). face: blinks vs pose changes and mouth swaps, lashes while shut, mouth bones, blink timing.",
    inputSchema: {
      input: inputPath, skeleton: skeletonName,
      runtime: z.boolean().optional(),
      loopAnimations: z.array(z.string()).optional().describe("Must loop cleanly (default: idle/walk/run/loop/cycle names)"),
      fps: z.number().positive().optional(),
      face: z.object({
        animations: z.array(z.string()).optional().describe("Default: all but `blink`"),
        lids: z.array(z.string()).optional().describe("Eyelid bones (default: named lid)"),
        closedFrom: z.string().optional().describe("Shut lids pose, \"animation@seconds\""),
        eyes: z.array(z.object({ slot: z.string(), closed: z.array(z.string()).optional() })).optional()
          .describe("Eye slots: shut while hidden or on a `closed` attachment"),
        blink: z.string().optional().describe("Blink played on a track above"),
        bones: z.array(z.string()).optional().describe("Pose-change bones (default: neck/head)"),
        rotateSpeed: z.number().positive().optional().describe("deg/s (default 20)"),
        moveSpeed: z.number().positive().optional().describe("units/s (default 8% of height)"),
        hide: z.array(z.string()).optional().describe("Hidden while shut (default: named lash)"),
        mouths: z.array(z.string()).optional().describe("Default: mouth/lips slots"),
        mouthGroups: z.array(z.object({ slot: z.string(), attachment: z.string(), bones: z.array(z.string()) })).optional()
          .describe("Bones of one mouth drawing: at setup while another is shown"),
        fps: z.number().positive().optional().describe("For frame counts (default: skeleton fps or 30)"),
        faces: z.array(z.looseObject({ name: z.string() })).optional().describe("Several faces, one audit each: {name, + lids…mouthGroups as above}"),
      }).optional().describe("Face audit (docs/USAGE.md#faces)"),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ input, skeleton, runtime, loopAnimations, fps, face }) => {
    const res = await loadProject(config, cli, input);
    const s = pickSkeleton(res, skeleton);
    const imagesDir = projectImagesDir(input, s.doc);
    const issues = validateSkeleton(s.doc, { runtime, loopAnimations, fps, images: imagesDir ? folderImages(imagesDir) : undefined });
    let report;
    if (face) {
      for (const f of face.faces ?? []) {
        for (const k of ["lids", "bones", "hide", "mouths"] as const) {
          const v = (f as Record<string, unknown>)[k];
          if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) throw new UserError(`face "${f.name}": ${k} must be a list of names`);
        }
        for (const k of ["eyes", "mouthGroups"] as const) {
          const v = (f as Record<string, unknown>)[k];
          if (v !== undefined && !(Array.isArray(v) && v.every((x) => x && typeof x === "object" && typeof (x as { slot?: unknown }).slot === "string"))) throw new UserError(`face "${f.name}": ${k} must be a list of {slot, …}`);
        }
      }
      try { report = faceAudit(s.doc, face as Parameters<typeof faceAudit>[1]); } catch (e) { throw new UserError((e as Error).message); }
      issues.push(...report.issues);
    }
    const shown = issues.slice(0, 150);
    return json({
      skeleton: s.name, ...issueCounts(issues), issues: shown, truncated: issues.length > shown.length ? issues.length - shown.length : undefined,
      ...(report ? { face: { ...report, issues: undefined, animations: report.animations.slice(0, 20).map((a) => ({ ...a, poseChanges: a.poseChanges.slice(0, 30), mouthSwaps: a.mouthSwaps.slice(0, 30), blinks: a.blinks.slice(0, 30), partialBlinks: a.partialBlinks.slice(0, 10), visibleWhileShut: a.visibleWhileShut.slice(0, 20), hiddenWhileOpen: a.hiddenWhileOpen.slice(0, 20), mouthGroups: a.mouthGroups.slice(0, 20) })) } } : {}),
    });
  }));

  server.registerTool("spine_measure", {
    title: "Measure animation motion",
    description: "Samples an animation in spine-core (constraints, physics warmed up); per bone: rotation range, path, peak speeds, pops, holds, loop seam. rootMotion: what SkeletonRootMotion reads (travel, sliding feet, in-place speed). parts: how far each slot travels.",
    inputSchema: {
      input: inputPath, skeleton: skeletonName,
      animation: z.string(),
      bones: z.array(z.string()).optional(),
      fps: z.number().positive().optional(),
      skin: z.string().optional(),
      warmupLoops: z.number().int().min(0).max(10).optional(),
      includeSamples: z.boolean().optional().describe("Per-frame world x/y/rotation"),
      limit: z.number().int().min(1).max(200).optional().describe("Most-moving bones shown (default 12)"),
      rootMotion: z.object({
        bone: z.string().optional().describe("rootMotionBoneName (default root)"),
        feet: z.array(z.string()).optional(),
      }).optional(),
      parts: z.number().positive().optional().describe("Scale: px per unit"),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ input, skeleton, animation, bones, fps, skin, warmupLoops, includeSamples, limit = 12, rootMotion, parts }) => {
    const res = await loadProject(config, cli, input);
    const s = pickSkeleton(res, skeleton);
    if (parts !== undefined) {
      try { return json({ skeleton: s.name, animation, ...partTravel(loadSkeletonData(s.doc, s.name), animation, parts, { fps, skin, warmupLoops }) }); } catch (e) { throw new UserError((e as Error).message); }
    }
    if (rootMotion) {
      try { return json({ skeleton: s.name, rootMotion: rootMotionReport(s.doc, animation, rootMotion) }); } catch (e) { throw new UserError((e as Error).message); }
    }
    const data = loadSkeletonData(s.doc, s.name);
    const sampled = sampleAnimation(data, animation, { fps, bones, skin, warmupLoops });
    const report = measureMotion(sampled);
    const moving = report.bones.filter((b) => b.moving);
    const activity = (b: (typeof moving)[number]) => b.position.pathLength + b.rotation.range;
    const shown = bones?.length ? report.bones : [...moving].sort((a, b) => activity(b) - activity(a)).slice(0, limit);
    const out: Record<string, unknown> = { ...report, bones: shown };
    if (!bones?.length) {
      out.selection = { moving: moving.length, still: report.bones.length - moving.length, shown: shown.length, order: "most movement first" };
      if (moving.length > shown.length) out.otherMovingBones = [...moving].sort((a, b) => activity(b) - activity(a)).slice(limit).map((b) => b.bone);
    }
    if (sampled.nanFrames.length) out.nanFrames = sampled.nanFrames;
    if (includeSamples) {
      const idx = shown.map((b) => sampled.bones.indexOf(b.bone));
      out.samples = sampled.samples.map((row) => idx.map((i) => {
        const f = row[i]!;
        return [+f.x.toFixed(2), +f.y.toFixed(2), +f.rotation.toFixed(2)];
      }));
      out.sampleColumns = "[frame][bone in `bones` order] = [worldX, worldY, worldRotation]";
    }
    if (JSON.stringify(out).length > MAX_CHARS) {
      throw new UserError(`Result too large (${JSON.stringify(out).length} chars); pass fewer \`bones\`, a lower \`limit\`, or drop includeSamples.`);
    }
    return json(out);
  }));

  server.registerTool("spine_timing", {
    title: "Animation timing report",
    description: "Timing structure from the keys: key poses and intervals, segment durations, ease type per segment, holds.",
    inputSchema: {
      input: inputPath, skeleton: skeletonName, animation: z.string(),
      bones: z.array(z.string()).optional(),
      detail: z.boolean().optional().describe("Per-bone segments"),
      limit: z.number().int().min(1).max(100).optional(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ input, skeleton, animation, bones, detail, limit = 12 }) => {
    const s = pickSkeleton(await loadProject(config, cli, input), skeleton);
    const anim = s.doc.animations?.[animation];
    if (!anim) throw new UserError(`Animation "${animation}" not found. Available: ${Object.keys(s.doc.animations ?? {}).join(", ")}`);
    const rep = timingReport(animation, anim, bones);
    const sorted = [...rep.bones].sort((a, b) => b.keys - a.keys);
    const out = { ...rep, bones: detail ? sorted.slice(0, limit) : sorted.slice(0, limit).map((b) => ({ bone: b.bone, kind: b.kind, keys: b.keys, times: b.times })) };
    if (JSON.stringify(out).length > MAX_CHARS) throw new UserError("Result too large; pass `bones` or a lower `limit`.");
    return json(out);
  }));

  server.registerTool("spine_compare_animations", {
    title: "Compare two animations",
    description: "A/B of two animations of one skeleton: duration, motion ratio, per-bone changes (biggest first), timing structure; optional contact sheets.",
    inputSchema: {
      input: inputPath, skeleton: skeletonName,
      a: z.string().describe("Baseline"), b: z.string(),
      bones: z.array(z.string()).optional(), fps: z.number().positive().optional(),
      limit: z.number().int().min(1).max(60).optional(),
      render: z.boolean().optional().describe(".spine input, ~8 s"),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ input, skeleton, a, b, bones, fps, limit, render }) => {
    const res = await loadProject(config, cli, input);
    const s = pickSkeleton(res, skeleton);
    for (const n of [a, b]) if (!s.doc.animations?.[n]) throw new UserError(`Animation "${n}" not found. Available: ${Object.keys(s.doc.animations ?? {}).join(", ")}`);
    const result = compareMotion(loadSkeletonData(s.doc, s.name), s.doc.animations!, a, b, { fps, bones, limit });
    if (!render) return json(result);
    if (res.kind !== "spine") throw new UserError("render needs a .spine project input");
    const images = [];
    for (const n of [a, b]) {
      const r = await renderFrames(config, cli, input, { skeleton: s.name, animation: n, scale: 30, cache: { imagesDir: projectImagesDir(input, s.doc) } });
      images.push({ type: "image" as const, data: contactSheet(r.frames, { maxFrames: 8, cell: 192, columns: 8 }).png.toString("base64"), mimeType: "image/png" });
    }
    return json({ ...result, images: [`1: ${a}`, `2: ${b}`] }, images);
  }));

  server.registerTool("spine_render_frames", {
    title: "Render animation frames",
    description: "Renders an animation with Spine's renderer (~4 s, cached) and returns a contact sheet. No MSAA or physics warm-up: for checking, not final video.",
    inputSchema: {
      project: z.string(),
      animation: z.string(), skeleton: skeletonName,
      fps: z.number().positive().max(60).optional(),
      scale: z.number().positive().max(400).optional().describe("Percent (default 50)"),
      skin: z.string().optional(),
      maxFrames: z.number().int().min(1).max(36).optional(),
      cell: z.number().int().min(64).max(512).optional().describe("Max cell px"),
      refresh: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ project, animation, skeleton, fps, scale, skin, maxFrames, cell, refresh }) => {
    assertInputPath(project, [".spine"]);
    const res = await loadProject(config, cli, project);
    const s = pickSkeleton(res, skeleton);
    if (!s.doc.animations?.[animation]) throw new UserError(`Animation "${animation}" not found. Available: ${Object.keys(s.doc.animations ?? {}).join(", ")}`);
    const r = await renderFrames(config, cli, project, { skeleton: s.name, animation, fps, scale, skin, cache: { imagesDir: projectImagesDir(project, s.doc), refresh } });
    const sheet = contactSheet(r.frames, { maxFrames, cell });
    const renderFps = fps ?? 30;
    return json({
      dir: r.dir, frames: r.frames.length, fps: renderFps, seconds: r.cli.seconds, cached: r.cached,
      contactSheet: { columns: sheet.columns, frameIndices: sheet.picked, times: sheet.picked.map((i) => +(i / renderFps).toFixed(3)) },
    }, [{ type: "image", data: sheet.png.toString("base64"), mimeType: "image/png" }]);
  }));
}
