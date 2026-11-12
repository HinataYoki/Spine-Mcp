import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { profileReport, withProfile, type Config } from "../config.js";
import type { SpineCli } from "../spine/cli.js";
import { PRESETS, exportRuntime, packSweep } from "../spine/export.js";
import { makeShowcase } from "../spine/showcase.js";
import { makeReview } from "../spine/review.js";
import { motionVisual } from "../spine/viz.js";
import { referenceTiming } from "../spine/reftiming.js";
import { inspectVideo } from "../spine/videoinspect.js";
import { videoFrames } from "../spine/videoframes.js";
import { unityPerf } from "../spine/unity-perf.js";
import { installedUnityVersions, unityCheck } from "../spine/unity.js";
import { unityImport } from "../spine/unity-import.js";
import { auditUnityProject } from "../spine/unity-audit.js";
import { parseProjectInfo } from "../spine/info.js";
import { UserError } from "../spine/project.js";
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { webCheck } from "../spine/web.js";
import { guarded, json, pixelRect, whole } from "./util.js";

export function registerExportTools(server: McpServer, config: Config, cli: SpineCli) {
  server.registerTool("spine_export", {
    title: "Export runtime files",
    description: [
      "Exports runtime files (JSON and/or .skel plus a packed atlas, optional scales), verified with spine-core in a temp folder before copying to outputDir (no overwrite unless set; project untouched, ~3-5 s).",
      "Reports page fill and texture memory. sweep: ranks atlas settings by texture memory and pages, writing nothing.",
    ].join(" "),
    inputSchema: {
      preset: z.enum(["mobile", "desktop", "web"]).optional().describe("mobile/desktop: binary, PMA, 2048/4096; web: JSON, PMA, 2048"),
      atlasPerSkin: z.boolean().optional(),
      editorVersion: z.string().optional().describe('Data format editor: "project" or e.g. "4.2.43" (default pinned)'),
      project: z.string(),
      outputDir: z.string().optional().describe("Not for sweep"),
      format: z.enum(["json", "binary", "both"]).optional(),
      atlas: z.boolean().optional(),
      atlasName: z.string().optional(),
      scales: z.array(z.number().positive().max(4)).optional().describe("e.g. [1, 0.5]"),
      maxSize: z.number().int().min(64).max(16384).optional(),
      premultipliedAlpha: z.boolean().optional(),
      nonessential: z.boolean().optional(),
      prettyPrint: z.boolean().optional(),
      imagesDir: z.string().optional(),
      clean: z.boolean().optional().describe("Spine's animation clean up"),
      overwrite: z.boolean().optional(),
      pot: z.boolean().optional(),
      packing: z.enum(["polygons", "rectangles"]).optional(),
      padding: z.number().int().min(0).max(16).optional(),
      sweep: z.object({
        maxSize: z.array(z.number().int().min(64).max(16384)).optional(),
        pot: z.array(z.boolean()).optional(),
        packing: z.array(z.enum(["polygons", "rectangles"])).optional(),
        padding: z.array(z.number().int().min(0).max(16)).optional(),
      }).optional().describe("Values to try"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, guarded(async (input) => {
    const { args: { sweep, outputDir, ...args }, defaults } = withProfile(config, "spine_export", input, input.preset ? Object.keys(PRESETS[input.preset]) : []);
    if (sweep) return json({ mode: "sweep", ...(await packSweep(config, cli, { ...args, sweep })) });
    if (!outputDir) throw new UserError("outputDir is required (or sweep)");
    return json(profileReport(config, defaults, await exportRuntime(config, cli, { ...args, outputDir })));
  }));

  server.registerTool("spine_showcase", {
    title: "Make a showcase animation",
    description: [
      "1-4 animations rendered by Spine side by side, labelled, as an animated .webp (alpha), .gif or .mp4 written only to output. For before/after and reels. Needs ImageMagick plus img2webp or ffmpeg.",
    ].join(" "),
    inputSchema: {
      project: z.string(),
      items: z.array(z.object({
        animation: z.string(),
        label: z.string().optional().describe('"" hides it'),
        skin: z.string().optional(),
      })).min(1).max(4),
      output: z.string().describe(".webp, .gif or .mp4"),
      skeleton: z.string().optional(),
      width: z.number().int().min(64).max(3840).optional(),
      fps: z.number().int().min(5).max(60).optional(),
      scale: z.number().min(5).max(400).optional().describe("Percent"),
      background: z.string().optional().describe('"transparent" (webp) or hex'),
      hold: z.number().min(0).max(10).optional().describe("Last-frame hold, s"),
      loops: z.number().int().min(1).max(10).optional(),
      align: z.enum(["bottom", "center"]).optional(),
      overwrite: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, guarded(async (args) => {
    const { previewPng, ...result } = await makeShowcase(config, cli, args);
    return json(result, [{ type: "image", data: previewPng.toString("base64"), mimeType: "image/png" }]);
  }));

  server.registerTool("spine_unity_check", {
    title: "Check the export in Unity",
    description: [
      "Fresh export into a throwaway Unity project, every animation vs spine-core bone by bone (~30 s); perf: CPU/GC per skeleton.",
      "Options: docs/USAGE.md#into-your-unity-project.",
    ].join(" "),
    inputSchema: {
      project: z.string(),
      unityVersion: z.string().optional().describe(`Default newest: ${installedUnityVersions().join(", ") || "none found"}`),
      format: z.enum(["json", "binary"]).optional(),
      samples: z.number().int().min(2).max(200).optional(),
      premultipliedAlpha: z.boolean().optional(),
      render: z.boolean().optional().describe("vs Spine's render"),
      renderAnimations: z.array(z.string()).optional(),
      renderFps: z.number().int().min(1).max(30).optional(),
      renderScale: z.number().min(10).max(200).optional(),
      colorSpace: z.enum(["gamma", "linear"]).optional(),
      renderPipeline: z.enum(["built-in", "urp"]).optional(),
      urpShaders: z.boolean().optional(),
      mecanimTransitions: z.array(z.object({
        from: z.string(), to: z.string(),
        duration: z.number().min(0).max(5).optional(),
        at: z.number().min(0).optional(),
        trace: z.string().optional().describe("Bone traced per frame"),
        mode: z.enum(["mixNext", "alwaysMix", "hard", "match"]).optional(),
        autoReset: z.boolean().optional(),
      })).max(20).optional()
        .describe("SkeletonMecanim vs the simulation"),
      renderComponent: z.enum(["animation", "graphic"]).optional(),
      canvasGroup: z.boolean().optional(),
      tracks: z.array(z.string()).min(1).max(8).optional().describe("Looping, one per track"),
      tracksSeconds: z.number().positive().max(120).optional(),
      tracksPhysics: z.boolean().optional(),
      batching: z.boolean().optional().describe("spine-unity draw calls"),
      compression: z.array(z.enum(["etc2", "astc4x4", "astc5x5", "astc6x6", "astc8x8", "astc10x10", "astc12x12"])).min(1).max(7).optional()
        .describe("Android formats vs RGBA32"),
      spineUnity: z.string().optional().describe("Commit, or a Unity project's lock"),
      perf: z.object({
        animations: z.array(z.string()).optional(), counts: z.array(z.number()).optional(),
        frames: z.number().optional(), skin: z.string().optional(),
      }).optional(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async (input) => {
    const { args, defaults } = withProfile(config, "spine_unity_check", input);
    const { perf, ...check } = args;
    const { visualPng, compressionPng, ...result } = profileReport(config, defaults, await unityCheck(config, cli, check));
    if (perf) Object.assign(result, { perf: await unityPerf(config, cli, { project: args.project, unityVersion: args.unityVersion, spineUnity: args.spineUnity, ...perf }) });
    return json(result, [visualPng, compressionPng].filter((p): p is Buffer => !!p).map((p) => ({ type: "image" as const, data: p.toString("base64"), mimeType: "image/png" })));
  }));

  server.registerTool("spine_review_video", {
    title: "Review video",
    description: [
      "Review cut MP4: each animation rendered by Spine at each speed, every frame labelled (animation, speed, frame, time); optional audio under real-time passes and a title card. Writes only output.",
    ].join(" "),
    inputSchema: {
      project: z.string(), skeleton: z.string().optional(),
      animations: z.array(z.string()).min(1).max(6),
      speeds: z.array(z.number().positive().max(4)).max(4).optional(),
      loops: z.number().int().min(1).max(8).optional(),
      fps: z.number().int().min(8).max(60).optional(),
      scale: z.number().min(5).max(200).optional(), skin: z.string().optional(),
      background: z.string().optional(),
      audio: z.string().optional(), audioOffset: z.number().min(0).optional(),
      title: z.string().max(80).optional(),
      output: z.string().describe(".mp4"), overwrite: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, guarded(async (args) => {
    const { previewPng, ...result } = await makeReview(config, cli, args);
    return json(result, [{ type: "image", data: previewPng.toString("base64"), mimeType: "image/png" }]);
  }));

  server.registerTool("spine_motion_visual", {
    title: "Onion skin, arcs and curves",
    description: [
      "Onion skin, bone arcs (one dot per frame) and value curves of one animation as an image, plus the numbers. Bones default to the 3 that travel furthest.",
    ].join(" "),
    inputSchema: {
      project: z.string(), skeleton: z.string().optional(),
      animation: z.string(), mode: z.enum(["onion", "arcs", "graph", "all"]).optional(),
      bones: z.array(z.string()).max(6).optional(), fps: z.number().int().min(5).max(60).optional(),
      ghosts: z.number().int().min(2).max(24).optional(), size: z.number().int().min(240).max(1200).optional(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async (args) => {
    const { png, ...result } = await motionVisual(config, cli, args);
    return json(result, [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
  }));

  server.registerTool("spine_reference_timing", {
    title: "Timing from a reference video",
    description: [
      "Timing from a reference video (optional crop): motion peaks, holds, cuts and repeat period as a frame table, graph and sheet. compare aligns a Spine animation on the peaks (speed ratio, offset, per-peak frames).",
    ].join(" "),
    inputSchema: {
      video: z.string(),
      start: z.number().min(0).optional(), end: z.number().positive().optional(),
      crop: pixelRect.optional(),
      fps: z.number().int().min(6).max(60).optional(),
      compare: z.object({ project: z.string(), skeleton: z.string().optional(), animation: z.string(), scale: z.number().min(5).max(200).optional() }).optional(),
      sheet: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async (args) => {
    const { png, ...result } = await referenceTiming(config, cli, args);
    return json(result, png ? [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] : []);
  }));

  server.registerTool("spine_video_inspect", {
    title: "Inspect a video frame by frame",
    description: [
      "Frame-by-frame video check: encoding (VFR, size, pixel format, audio), segments at cuts and transitions with hold pattern (ones/twos), flashes, stutters, dropped frames, motion peaks, audio onsets vs cuts/peaks; an event list, per-frame curves and an overview sheet.",
      "verify compares a segment with a Spine animation. Exact frames: spine_video_frames.",
    ].join(" "),
    inputSchema: {
      video: z.string(),
      start: z.number().min(0).optional(), end: z.number().positive().optional(),
      crop: pixelRect.optional(),
      fps: z.number().int().min(6).max(120).optional(),
      verify: z.object({ project: z.string(), skeleton: z.string().optional(), animation: z.string(), segment: whole().optional(), start: z.number().min(0).optional(), end: z.number().positive().optional(), crop: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().positive(), height: z.number().int().positive() }).optional() }).optional(),
      sheet: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async (args) => {
    const { png, ...result } = await inspectVideo(config, cli, args);
    return json(result, png ? [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] : []);
  }));

  server.registerTool("spine_video_frames", {
    title: "Exact video frames",
    description: "Exact video frames by number (spine_video_inspect's numbering) as a labelled sheet; diff marks changes in red, onion blends them. Up to 48 per call.",
    inputSchema: {
      video: z.string(),
      frames: z.array(z.number().int().min(0)).max(200).optional(),
      range: z.object({ from: whole(), to: whole(), step: whole(1).optional() }).optional(),
      start: z.number().min(0).optional(), end: z.number().positive().optional(), fps: z.number().int().min(6).max(120).optional(),
      crop: pixelRect.optional(),
      mode: z.enum(["frames", "diff", "onion"]).optional(), width: z.number().int().min(80).max(1920).optional(), columns: z.number().int().min(1).max(12).optional(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async (args) => {
    const { png, ...result } = await videoFrames(config, args);
    return json(result, [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
  }));

  server.registerTool("spine_unity_import", {
    title: "Import into a Unity project",
    description: [
      "Imports a .spine into a Unity project with spine-unity (data, atlas, materials, mixes, prefab), then compares it bone by bone with spine-core; reports texture settings and render pipeline.",
      "Dry-run by default. update: replace in place (backed up, GUIDs kept). With Unity open, only files are copied. audit: read-only scan (version, data files, API changes).",
    ].join(" "),
    inputSchema: {
      project: z.string().optional().describe("Not for audit"),
      unityProject: z.string(),
      audit: z.boolean().optional(),
      sources: z.array(z.string()).max(50).optional().describe("audit: .spine files or folders"),
      folder: z.string().optional().describe("Default Assets/Spine/<name>"),
      format: z.enum(["json", "binary"]).optional(),
      premultipliedAlpha: z.boolean().optional(),
      prefab: z.boolean().optional(),
      component: z.enum(["animation", "graphic", "mecanim"]).optional(),
      referenceAssets: z.boolean().optional(),
      followers: z.array(z.string()).optional().describe("Bones with a BoneFollower child"),
      startingAnimation: z.string().optional(), loop: z.boolean().optional(), skin: z.string().optional(),
      defaultMix: z.number().min(0).max(10).optional(),
      mixes: z.array(z.object({ from: z.string(), to: z.string(), duration: z.number().min(0).max(10) })).max(400).optional(),
      update: z.boolean().optional(), apply: z.boolean().optional(),
      unityVersion: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, guarded(async (input) => {
    const { args: { audit, sources, ...args }, defaults } = withProfile(config, "spine_unity_import", input);
    if (audit) {
      // Source projects: .spine files given or found up to three folders deep; skeleton names from the Spine CLI.
      const files: string[] = [];
      const find = (p: string, depth: number) => {
        if (!isAbsolute(p)) throw new UserError(`sources must be absolute paths: ${p}`);
        if (p.endsWith(".spine") && existsSync(p)) { files.push(p); return; }
        if (depth > 3) return;
        let entries: string[] = [];
        try { entries = readdirSync(p); } catch { return; }
        for (const e of entries) if (!e.startsWith(".") && !e.endsWith("-mcp-staging.spine")) find(join(p, e), depth + 1);
      };
      for (const p of sources ?? []) find(p, 0);
      let projects: { project: string; skeletons: { name: string; hash: null }[] }[] = [];
      if (files.length) {
        const r = await cli.run(files.slice(0, 100).flatMap((p) => ["-i", p]));
        projects = parseProjectInfo(r.lines).map((pi, i) => ({ project: pi.path ?? files[i]!, skeletons: pi.skeletons.map((sk) => ({ name: sk.name, hash: null })) }));
      }
      return json({ mode: "audit", sources: files.length, ...auditUnityProject(args.unityProject, { sources: projects }) });
    }
    if (!args.project) throw new UserError("project is required (or audit: true)");
    return json(profileReport(config, defaults, await unityImport(config, cli, { ...args, project: args.project, ...(config.profile?.unity ? { team: config.profile.unity } : {}) }), true));
  }));

  server.registerTool("spine_web_check", {
    title: "Check the export on the web runtime",
    description: [
      "Renders a fresh export with spine-webgl in headless Chrome and compares every frame with Spine's render (silhouette IoU, colour difference, worst frame). Needs Chrome or CHROME_BIN.",
    ].join(" "),
    inputSchema: {
      project: z.string(),
      animations: z.array(z.string()).optional(),
      fps: z.number().int().min(1).max(30).optional(),
      scale: z.number().min(10).max(200).optional(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async (args) => {
    const { visualPng, ...result } = await webCheck(config, cli, args);
    return json(result, visualPng ? [{ type: "image", data: visualPng.toString("base64"), mimeType: "image/png" }] : []);
  }));
}
