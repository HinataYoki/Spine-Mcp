import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { createBackup, listBackups, restoreFile, sha256File } from "../spine/backup.js";
import type { SpineCli } from "../spine/cli.js";
import { deriveAnimationWithNotes, type DeriveOp } from "../spine/derive.js";
import { EDITOR_OPEN_NOTE, editorStatus } from "../spine/editor.js";
import { blink, breathe, followThrough, lookAt, settle, suggest, sway } from "../spine/generate.js";
import { gaze } from "../spine/face.js";
import { mergePlan } from "../spine/merge.js";
import { lipSync } from "../spine/lipsync.js";
import { headTurn, squashStretch } from "../spine/deform.js";
import { blockingFromPoses, loadLibrary, poseCandidates, savePoses } from "../spine/poses.js";
import { suggestWalk, walkCycle, type WalkLeg } from "../spine/walk.js";
import { rigEdit, type RigEditOptions } from "../spine/rigedit.js";
import { importLayers } from "../spine/layers.js";
import { autoRig, type AutoRigOptions } from "../spine/autorig.js";
import "../spine/layers.js"; // ag-psd canvas setup
import { updateImages, type UpdateImagesOptions } from "../spine/imageupdate.js";
import { assertInputPath, loadProject, pickSkeleton, UserError } from "../spine/project.js";
import type { AnimationJson } from "../spine/types.js";
import { transferAnimation } from "../spine/transfer.js";
import { addAnimation } from "../spine/write.js";
import { recordStep } from "../spine/trajectory.js";
import { guarded, json, whole } from "./util.js";
import { existsSync, readFileSync } from "node:fs";
import { readPsd } from "ag-psd";
import { artQa } from "../spine/artqa.js";
import type { SourceImage } from "../spine/cutqa.js";
import { collectParts, partsFromLayout, type Part } from "../spine/autorig.js";

/** Art checks on a PSD's parts or a parts folder (joints without overlap, covered parts, specks, oversized art). */
function partsArtQa(src: { psd?: string; parts?: string; layout?: string }, targetHeight?: number) {
  // On the source's own pixels, so a suggested scale is absolute.
  const { parts, joints, source }: { parts: Part[]; joints?: [string, string][]; source?: SourceImage } = src.psd ? collectParts(readPsd(readFileSync(src.psd), { useImageData: true }), 1) : partsFromLayout(src.parts!, src.layout, 1);
  return artQa(parts, { targetHeight, ...(joints ? { joints } : {}), ...(source ? { source } : {}) });
}

const project = z.string().describe(".spine project");
const editor = z.enum(["auto", "staging", "inPlace"]).optional();
const stagingPath = z.string().optional();
const allowUpgrade = z.boolean().optional().describe("Write an older-version project");

export function registerWriteTools(server: McpServer, config: Config, cli: SpineCli) {
  server.registerTool("spine_add_animation", {
    title: "Add animation to project",
    description: [
      "Adds one Spine 4.3 JSON animation to a .spine project. Dry-run validates against the skeleton; apply backs up, imports only this animation through the CLI, re-exports, verifies and rolls back on any mismatch.",
      "Existing names need replace; prefer a new name. Times in seconds; rotate uses `value`; bezier `curve` is absolute [cx1,cy1,cx2,cy2] per channel.",
    ].join(" "),
    inputSchema: {
      project, skeleton: z.string().optional(),
      name: z.string(),
      animation: z.record(z.string(), z.unknown()),
      apply: z.boolean().optional(),
      replace: z.boolean().optional(),
      loopAnimations: z.array(z.string()).optional(),
      editor, stagingPath, allowUpgrade,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, guarded(async (a) => json(await addAnimation(config, cli, { ...a, animation: a.animation as AnimationJson }))));

  const op = z.discriminatedUnion("op", [
    z.object({
      op: z.literal("scaleValues"), factor: z.number().min(0),
      kinds: z.array(z.string()).optional().describe("rotate, translate, scale, shear (default all)"),
      bones: z.array(z.string()).optional(),
    }),
    z.object({ op: z.literal("retime"), factor: z.number().positive().describe("2 = half speed") }),
    z.object({ op: z.literal("keepBones"), bones: z.array(z.string()).min(1) }),
    z.object({ op: z.literal("dropBones"), bones: z.array(z.string()).min(1) }),
    z.object({
      op: z.literal("offsetBones"), bones: z.array(z.string()).min(1), seconds: z.number(),
      wrap: z.boolean().optional(),
    }),
    z.object({
      op: z.literal("offsetSlots"), slots: z.array(z.string()).min(1), seconds: z.number(),
      wrap: z.boolean().optional(),
    }),
    z.object({
      op: z.literal("loopFix"), bones: z.array(z.string()).optional(),
      slots: z.array(z.string()).optional(),
    }),
    z.object({
      op: z.literal("ease"), easing: z.string().describe("linear, stepped, ease, easeIn|Out|InOut[Sine|Cubic], easeOutBack, easeInBack, cubic-bezier(x1,y1,x2,y2)"),
      bones: z.array(z.string()).optional(), kinds: z.array(z.string()).optional(),
      slots: z.array(z.string()).optional(),
    }),
    z.object({
      op: z.literal("swapBones"),
      pairs: z.array(z.tuple([z.string(), z.string()])).optional().describe("Default: from names"),
    }),
    z.object({
      op: z.literal("mirror"),
      pairs: z.array(z.tuple([z.string(), z.string()])).optional().describe("Default: from names; [] = every bone in place"),
    }),
    z.object({ op: z.literal("repeat"), times: z.number().int().min(2).max(16) }),
    z.object({ op: z.literal("clean"), thin: z.boolean().optional(), bones: z.array(z.string()).optional() }),
    z.object({
      op: z.literal("bakePhysics"),
      bones: z.array(z.string()).optional(),
      fps: z.number().int().min(10).max(120).optional(),
      warmupLoops: z.number().int().min(0).max(20).optional(),
      loop: z.boolean().optional(),
      searchCycles: z.number().int().min(1).max(40).optional(),
      cycles: z.union([z.number().int().min(1).max(8), z.literal("auto")]).optional(),
      tolerance: z.object({ rotation: z.number().positive().optional(), position: z.number().positive().optional(), scale: z.number().positive().optional() }).optional(),
    }),
    z.object({
      op: z.literal("blocking"),
      keyPosesOnly: z.boolean().optional(),
      minTimelines: z.number().int().min(1).max(50).optional(),
    }),
    z.object({
      op: z.literal("spline"),
      smoothness: z.number().min(0).max(1).optional(),
      all: z.boolean().optional(),
      bones: z.array(z.string()).optional(), kinds: z.array(z.string()).optional(),
      loop: z.boolean().optional(),
    }),
    z.object({
      op: z.literal("events"),
      add: z.array(z.object({ time: z.number().min(0), name: z.string(), int: z.number().int().optional(), float: z.number().optional(), string: z.string().optional(), volume: z.number().min(0).max(1).optional(), balance: z.number().min(-1).max(1).optional() })).optional(),
      footsteps: z.object({ bones: z.array(z.string()).describe("Foot bones"), event: z.string(), string: z.string().optional(), int: z.number().int().optional(), volume: z.number().min(0).max(1).optional() }).optional(),
      replace: z.boolean().optional(),
    }).describe("Only events the skeleton defines"),
    z.object({
      op: z.literal("setupKeys"),
      from: z.array(z.string()).optional(),
    }),
  ]);

  server.registerTool("spine_derive_animation", {
    title: "Derive animation variant",
    description: "Builds a new animation from an existing one with ops applied in order on the server, then adds it like spine_add_animation (validated, backed up, verified; dry-run unless apply). Ops: docs/USAGE.md#derive-operations.",
    inputSchema: {
      project, skeleton: z.string().optional(),
      source: z.string(),
      name: z.string(),
      ops: z.array(op).min(1),
      apply: z.boolean().optional(), replace: z.boolean().optional(),
      loopAnimations: z.array(z.string()).optional(),
      editor, stagingPath, allowUpgrade,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, guarded(async ({ project: p, skeleton, source, name, ops, apply, replace, loopAnimations, editor: mode, stagingPath: sp, allowUpgrade: up }) => {
    const s = pickSkeleton(await loadProject(config, cli, p), skeleton);
    const src = s.doc.animations?.[source];
    if (!src) throw new UserError(`Animation "${source}" not found. Available: ${Object.keys(s.doc.animations ?? {}).join(", ")}`);
    const { animation, notes } = deriveAnimationWithNotes(src, ops as DeriveOp[], { skeleton: s.doc });
    return json({ source, ops, deriveNotes: notes, ...(await addAnimation(config, cli, { project: p, skeleton: s.name, name, animation, apply, replace, loopAnimations, editor: mode, stagingPath: sp, allowUpgrade: up, trace: { tool: "spine_derive_animation", detail: `${(ops as { op: string }[]).map((o) => o.op).join("+")} from ${source}` } })) });
  }));

  server.registerTool("spine_generate_animation", {
    title: "Generate animation from the rig",
    description: [
      "Generate a named animation draft. Fill the object matching type; missing controls return suggestions. Dry-run by default; apply uses verified CLI animation import and backup. Types include breathe, blink, gaze, lookAt, sway, settle, followThrough, walk, blocking, turn, squash, lipSync. Seconds/degrees/skeleton units. See docs/USAGE.md#generate-options.",
    ].join(" "),
    inputSchema: {
      project, skeleton: z.string().optional(),
      type: z.enum(["breathe", "blink", "gaze", "lookAt", "followThrough", "lipSync", "turn", "squash", "blocking", "walk", "sway", "settle"]),
      name: z.string().optional(),
      breathe: z.object({
        torso: z.array(z.string()).optional(),
        followers: z.array(z.string()).optional(),
        period: z.number().positive().max(20).optional(),
        amount: z.number().positive().max(0.3).optional().describe("scaleY gain"),
        rise: z.number().positive().optional(),
        rotate: z.number().optional(),
        lag: z.number().min(0).max(0.5).optional().describe("Share of period"),
        path: z.enum(["line", "figure8"]).optional(),
        sway: z.number().positive().optional(),
        swayPeriod: z.number().positive().max(60).optional(),
        swayLag: z.number().min(0).max(1).optional(),
        phase: z.number().min(0).max(1).optional(),
        restStart: z.boolean().optional(),
      }).optional(),
      blink: z.object({
        eyes: z.array(z.object({ slot: z.string(), open: z.string().describe('"" when the slot is empty while open (a lid drawn over the eye)'), closed: z.string(), half: z.string().optional() })).optional(),
        lids: z.array(z.object({
          bone: z.string(), closedScale: z.number().min(0).max(1).optional(),
          closed: z.object({ x: z.number().optional(), y: z.number().optional(), rotate: z.number().optional(), scaleX: z.number().optional(), scaleY: z.number().optional() }).optional()
            .describe("Offsets from setup"),
          closedFrom: z.string().optional().describe("anim@seconds"), openFrom: z.string().optional(),
        })).optional(),
        duration: z.number().positive().max(60).optional(),
        at: z.number().min(0).optional(),
        blinks: z.array(z.object({ time: z.number().min(0), double: z.boolean().optional() })).max(60).optional(),
        closeTime: z.number().positive().max(1).optional(),
        holdTime: z.number().min(0).max(1).optional(),
        openTime: z.number().positive().max(1).optional(),
        blinkTime: z.number().positive().max(1).optional(),
        double: z.boolean().optional(),
        hide: z.array(z.string()).optional().describe("Slots hidden while shut"),
        hideAt: z.number().gt(0).lt(1).optional(),
        onPoses: z.object({
          source: z.string(),
          bones: z.array(z.string()).optional(),
          rotateSpeed: z.number().positive().optional(),
          moveSpeed: z.number().positive().optional(),
          minGap: z.number().min(0).max(10).optional(),
        }).optional(),
        fill: z.number().positive().max(20).optional().describe("Max gap between blinks"),
      }).optional(),
      gaze: z.object({
        bones: z.array(z.string()).optional(),
        fixations: z.array(z.object({ time: z.number().min(0), x: z.number(), y: z.number() })).max(100).optional(),
        count: z.number().int().min(1).max(60).optional(),
        seed: whole(-1e9).optional(),
        radius: z.number().positive().optional(),
        duration: z.number().positive().max(60).optional(),
        dart: z.number().positive().max(0.5).optional(),
        drift: z.number().min(0).max(1).optional(),
        brows: z.object({ bones: z.array(z.string()), lift: z.number().optional(), arch: z.number().optional(), dip: z.number().optional(), dips: z.array(z.number().min(0)).optional() }).optional(),
      }).optional(),
      lookAt: z.object({
        bones: z.array(z.string()).optional().describe("Base to head"),
        weights: z.array(z.number()).optional(),
        eyeBones: z.array(z.object({ bone: z.string(), range: z.number().positive().optional() })).optional(),
        looks: z.array(z.object({ time: z.number().min(0), angle: z.number().optional(), x: z.number().optional(), y: z.number().optional(), eyes: z.tuple([z.number(), z.number()]).optional() })).optional(),
        facing: z.number().optional().describe("0 right, 180 left"),
        amount: z.number().min(0).max(1).optional(), limit: z.number().positive().max(180).optional(),
        turnTime: z.number().positive().max(3).optional(), lead: z.number().min(0).max(1).optional(), overshoot: z.number().min(0).max(0.5).optional(),
        duration: z.number().positive().max(60).optional(), loop: z.boolean().optional(),
      }).optional(),
      followThrough: z.object({
        source: z.string().optional(),
        bones: z.array(z.string()).optional().describe("Parent first"),
        strength: z.number().positive().optional(), damping: z.number().min(0).max(1).optional(), inertia: z.number().min(0).max(1).optional(),
        mass: z.number().positive().optional(), gravity: z.number().optional(), fps: z.number().positive().max(120).optional(), loop: z.boolean().optional(),
      }).optional(),
      lipSync: z.object({
        audio: z.string().optional(),
        slot: z.string().optional(), shapes: z.array(z.string()).optional().describe("Closed to widest"),
        jaw: z.object({ bone: z.string(), open: z.number() }).optional(),
        fps: z.number().positive().max(60).optional(), start: z.number().min(0).optional(), end: z.number().positive().optional(),
        gate: z.number().min(0).max(1).optional(), hold: z.number().int().min(1).max(12).optional(),
        mode: z.enum(["auto", "phonemes", "loudness"]).optional(),
        cues: z.record(z.enum(["A", "B", "C", "D", "E", "F", "G", "H", "X"]), z.string()).optional(),
        dialog: z.string().optional(),
        language: z.enum(["english", "other"]).optional(),
        audioEvent: z.string().optional(),
      }).optional(),
      turn: z.object({
        face: z.array(z.string()).optional(),
        features: z.array(z.object({ slot: z.string(), depth: z.number().min(0).max(2).optional() })).optional(),
        poses: z.array(z.object({ time: z.number().min(0), yaw: z.number().min(-80).max(80).optional(), pitch: z.number().min(-80).max(80).optional() })).optional(),
        turnTime: z.number().positive().max(3).optional(), duration: z.number().positive().max(60).optional(), loop: z.boolean().optional(),
      }).optional(),
      squash: z.object({
        slots: z.array(z.string()).optional(),
        keys: z.array(z.object({ time: z.number().min(0), amount: z.number().min(-0.8).max(2) })).optional().describe(">0 stretch, <0 squash"),
        source: z.string().optional().describe("Or a driving animation, with bone"),
        bone: z.string().optional(), strength: z.number().positive().max(5).optional(),
        axis: z.number().optional(), anchor: z.enum(["bottom", "center", "top"]).optional(), fps: z.number().positive().max(120).optional(),
      }).optional(),
      sway: z.object({ bones: z.array(z.string()).optional(), amount: z.number().optional(), period: z.number().positive().optional(), lag: z.number().min(0).optional(), harmonic: z.number().min(0).optional(), duration: z.number().positive().optional() }).optional(),
      settle: z.object({ bones: z.array(z.string()).optional(), amounts: z.array(z.number()).optional(), at: z.number().min(0).optional(), amount: z.number().optional(), swings: whole(1, 20).optional(), decay: z.number().gt(0).lt(1).optional(), period: z.number().positive().optional(), lag: z.number().min(0).optional(), ratio: z.number().min(0).optional(), duration: z.number().positive().optional() }).optional(),
      blocking: z.object({
        poses: z.array(z.object({ time: z.number().min(0), pose: z.string().describe("anim@seconds or saved name") })).optional(),
        duration: z.number().positive().max(120).optional(), loop: z.boolean().optional(),
        spline: z.union([z.boolean(), z.number().min(0).max(1)]).optional(),
        save: z.array(z.object({ name: z.string(), from: z.string() })).optional(),
      }).optional(),
      walk: z.object({
        legs: z.array(z.object({ thigh: z.string(), shin: z.string(), foot: z.string().optional() })).length(2).optional(),
        hip: z.string().optional(), arms: z.array(z.object({ bone: z.string(), swing: z.number().optional() })).optional(),
        style: z.enum(["walk", "run"]).optional(), period: z.number().positive().max(5).optional(),
        stride: z.number().positive().optional(), stepHeight: z.number().min(0).optional(), bob: z.number().min(0).optional(), crouch: z.number().min(0).optional(),
        facing: z.union([z.literal(1), z.literal(-1)]).optional(), lean: z.number().min(-45).max(45).optional(), fps: z.number().positive().max(120).optional(),
        view: z.enum(["side", "front"]).optional().describe("front: faces the camera, marches in place"),
        sway: z.number().min(0).optional(),
        footstepEvent: z.string().optional(),
      }).optional(),
      apply: z.boolean().optional(), replace: z.boolean().optional(),
      editor, stagingPath, allowUpgrade,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, guarded(async ({ project: p, skeleton, type, name, breathe: bo, blink: bl, gaze: gz, lookAt: la, followThrough: ft, lipSync: ls, turn: tu, squash: sq, blocking: bk, walk: wk, sway: sw, settle: se, apply, replace, editor: mode, stagingPath: sp, allowUpgrade: up }) => {
    const s = pickSkeleton(await loadProject(config, cli, p), skeleton);
    let saved: string[] | undefined;
    if (type === "blocking" && bk?.save?.length) {
      try { saved = savePoses(config, p, s.doc, bk.save); } catch (e) { throw new UserError((e as Error).message); }
      if (!bk.poses?.length) return json({ mode: "saved", type, savedPoses: saved, note: "Saved. Use them by name in blocking.poses." });
    }
    const ready = type === "breathe" ? !!bo?.torso?.length : type === "blink" ? !!(bl?.eyes?.length || bl?.lids?.length) : type === "gaze" ? !!gz?.bones?.length
      : type === "lookAt" ? !!(la?.bones?.length && la.looks?.length) : type === "followThrough" ? !!(ft?.source && ft.bones?.length) : type === "turn" ? !!(tu?.face?.length && tu.poses?.length)
      : type === "squash" ? !!(sq?.slots?.length && (sq.keys?.length || (sq.source && sq.bone))) : type === "blocking" ? !!bk?.poses?.length : type === "walk" ? !!(wk?.legs?.length === 2 && wk.hip) : type === "sway" ? !!sw?.bones?.length : type === "settle" ? !!se?.bones?.length : !!(ls?.audio && (ls.slot || ls.jaw));
    if (!ready) {
      const notes: Record<string, string> = {
        breathe: "Pass breathe.torso (and optionally followers) from these or your own bones, then call again.",
        blink: "Pass blink.eyes ({slot, open, closed, half?}) and/or blink.lids ({bone, closed? or closedFrom?}), optionally hide (lash slots) and onPoses ({source}), then call again.",
        gaze: "Pass gaze.bones (a look control bone, or the pupils from suggestions.look.eyeBones), then call again; fixations or a random count.",
        lookAt: "Pass lookAt.bones (base to head, e.g. suggestions.look.bones), lookAt.looks ([{time, angle} or {time, x, y}]) and optionally eyeBones, then call again.",
        followThrough: `Pass followThrough.source (one of: ${Object.keys(s.doc.animations ?? {}).slice(0, 12).join(", ")}) and followThrough.bones (parent first, e.g. from suggestions.dangling), then call again.`,
        turn: "Pass turn.face (face mesh slots, e.g. suggestions.faces), turn.poses ([{time, yaw, pitch}]) and features with depths (suggestions.features), then call again.",
        blocking: "",
        sway: "Pass sway.bones (a chain, parent first: suggestions.dangling), then call again.",
        settle: "Pass settle.bones (parent first: shoulder, elbow, wrist) and settle.at (when the gesture ends), then call again.",
        squash: `Pass squash.slots (mesh slots, e.g. suggestions.bodies) and keys ([{time, amount}]) or source (one of: ${Object.keys(s.doc.animations ?? {}).slice(0, 12).join(", ")}) with bone, then call again.`,
        lipSync: "Pass lipSync.audio and lipSync.slot with shapes ordered closed to open (from suggestions.mouths) and/or lipSync.jaw ({bone, open degrees}), then call again.",
      };
      if (type === "walk") return json({ mode: "suggestions", type, suggestions: suggestWalk(s.doc), note: "Pass walk.legs (two {thigh, shin, foot?}), walk.hip and optionally arms, style (walk or run), view (side, or front for a character drawn facing the camera), stride, period; legs and arms driven by the rig's IK get their targets keyed." });
      if (type === "blocking") return json({ mode: "suggestions", type, suggestions: { keyPoses: poseCandidates(s.doc), savedPoses: Object.keys(loadLibrary(config, p)) }, note: 'Pass blocking.poses ([{time, pose: "animation@seconds" or a saved name}]) from these key poses; save favourites with blocking.save.' });
      return json({ mode: "suggestions", type, suggestions: suggest(s.doc), note: notes[type] });
    }
    let gen;
    try {
      if (type === "breathe") gen = breathe(s.doc, { ...bo, torso: bo!.torso! });
      else if (type === "blink") gen = blink(s.doc, bl!);
      else if (type === "gaze") gen = gaze(s.doc, { ...gz!, bones: gz!.bones! });
      else if (type === "lookAt") gen = lookAt(s.doc, { ...la!, bones: la!.bones!, looks: la!.looks! });
      else if (type === "followThrough") {
        const src = s.doc.animations?.[ft!.source!];
        if (!src) throw new Error(`Animation "${ft!.source}" not found. Animations: ${Object.keys(s.doc.animations ?? {}).join(", ")}`);
        gen = followThrough(s.doc, src, { ...ft!, bones: ft!.bones! });
      } else if (type === "turn") gen = headTurn(s.doc, { ...tu!, face: tu!.face!, poses: tu!.poses! });
      else if (type === "squash") {
        const src = sq!.source ? s.doc.animations?.[sq!.source] : undefined;
        if (sq!.source && !src) throw new Error(`Animation "${sq!.source}" not found. Animations: ${Object.keys(s.doc.animations ?? {}).join(", ")}`);
        gen = squashStretch(s.doc, { ...sq!, slots: sq!.slots!, source: src });
      } else if (type === "walk") gen = walkCycle(s.doc, { ...wk!, legs: wk!.legs as [WalkLeg, WalkLeg], hip: wk!.hip! });
      else if (type === "sway") gen = sway(s.doc, { ...sw!, bones: sw!.bones! });
      else if (type === "settle") gen = settle(s.doc, { ...se!, bones: se!.bones! });
      else if (type === "blocking") gen = blockingFromPoses(s.doc, { ...bk!, poses: bk!.poses! }, loadLibrary(config, p));
      else gen = lipSync(s.doc, { ...ls!, audio: ls!.audio! });
    } catch (e) {
      throw new UserError((e as Error).message);
    }
    const animName = name ?? (type === "walk" ? wk?.style ?? "walk" : type === "followThrough" ? `${ft!.source}-follow` : type === "squash" && sq?.source ? `${sq.source}-squash` : type);
    const loops = type === "lipSync" || (type === "blocking" && bk?.loop === false) || (type === "lookAt" && la?.loop === false) || (type === "turn" && tu?.loop === false) || (type === "squash" && !sq?.source) ? [] : [animName];
    const write = await addAnimation(config, cli, { project: p, skeleton: s.name, name: animName, animation: gen.animation, apply, replace, loopAnimations: loops, editor: mode, stagingPath: sp, allowUpgrade: up, trace: { tool: "spine_generate_animation", detail: type } });
    return json({ type, generateNotes: gen.notes, ...(saved ? { savedPoses: saved } : {}), ...write });
  }));

  server.registerTool("spine_import_layers", {
    title: "PSD layers to a new Spine project",
    description: [
      "New Spine project from a layered PSD: a region per layer at its canvas position, draw order from layer order, bones from groups (or PhotoshopToSpine tags), images next to it; masks baked, unsupported effects reported.",
      "Or json: PhotoshopToSpine's output (checked). Or parts: PNGs placed by a layout JSON (See-through, cut-boxes or {parts:[{file,x,y|bbox|center,order,bone,pivot,slot}]}).",
      "Dry-run by default, never overwrites; verified by re-export and a render against the PSD or the placed parts. Places art only.",
    ].join(" "),
    inputSchema: {
      psd: z.string().optional(),
      json: z.string().optional(),
      parts: z.string().optional(),
      layout: z.string().optional().describe("Default: layout.json or parts.json in parts or its parent"),
      output: z.string().describe("New .spine"),
      skeleton: z.string().optional(),
      bones: z.enum(["groups", "root", "layers"]).optional(),
      origin: z.enum(["bottom-center", "center", "top-left"]).optional(),
      scale: z.number().positive().max(4).optional(),
      includeHidden: z.boolean().optional(),
      targetHeight: z.number().positive().optional().describe("Shown height in px: flags oversized art"),
      apply: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, guarded(async (args) => {
    const { targetHeight, ...rest } = args;
    const { png, ...result } = await importLayers(config, cli, rest);
    if (result.mode === "created") recordStep(config, args.output, { tool: "spine_import_layers", outcome: "created", detail: args.psd ?? args.json ?? args.parts });
    if ((args.psd && existsSync(args.psd)) || (args.parts && !result.parts?.problems.length)) (result as Record<string, unknown>).artQa = partsArtQa(args, targetHeight);
    return json(result, png ? [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] : []);
  }));

  const point = z.tuple([z.number(), z.number()]);
  server.registerTool("spine_auto_rig", {
    title: "Rig a layered PSD into a new Spine project",
    description: [
      "Starting rig in a new project from a layered PSD or parts + layout: bones at joints, traced meshes, weights, optional two-bone IK; hidden lids rigged shut-collapsed.",
      "Without bones: suggests a skeleton over the art (nothing written; riders: one character sits on another; rigFrom: an approved rig's joints); pass back as bones. With bones: dry-run with checks; apply writes, validates, runs rig QA, renders test poses. Never overwrites.",
    ].join(" "),
    inputSchema: {
      psd: z.string().optional(),
      parts: z.string().optional(),
      layout: z.string().optional(),
      output: z.string().describe("New .spine"),
      skeleton: z.string().optional(),
      bones: z.array(z.object({
        name: z.string(),
        parent: z.string().optional(),
        joint: point.describe("Canvas px, y down"),
        tip: point.optional(),
        layers: z.array(z.string()).optional(),
      })).optional(),
      ik: z.array(z.object({
        bones: z.tuple([z.string(), z.string()]),
        target: z.string().optional(),
        bendPositive: z.boolean().optional(),
      })).optional(),
      mesh: z.enum(["auto", "none", "sparse"]).optional(),
      weights: z.enum(["smooth", "rigid", "joint"]).optional(),
      density: z.number().positive().max(200).optional(),
      blend: z.number().positive().max(500).optional(),
      origin: z.enum(["bottom-center", "center", "top-left"]).optional(),
      scale: z.number().positive().max(4).optional(),
      targetHeight: z.number().positive().optional().describe("Shown height in px: flags oversized art"),
      riders: z.boolean().optional(),
      rigFrom: z.string().optional(),
      apply: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, guarded(async (args) => {
    const { targetHeight, ...rest } = args as AutoRigOptions & { targetHeight?: number };
    const { png, posePng, ...result } = await autoRig(config, cli, rest);
    if (result.mode === "created") recordStep(config, rest.output, { tool: "spine_auto_rig", outcome: "created", detail: `${rest.bones?.length ?? 0} bones from ${rest.psd ?? rest.parts}` });
    if (result.mode === "suggestions") (result as Record<string, unknown>).artQa = partsArtQa(rest, targetHeight);
    const images = [png, posePng].filter((b): b is Buffer => !!b).map((b) => ({ type: "image" as const, data: b.toString("base64"), mimeType: "image/png" }));
    return json(result, images);
  }));

  server.registerTool("spine_update_images", {
    title: "Bring new PSD art into an existing project",
    description: [
      "Updates a project's image files from a layered PSD without touching the .spine: layers matched to images and cut to their frames, so meshes and animations stay valid. placement psd takes the PSD's layout; grow enlarges a region image.",
      "Dry-run with before/after renders; apply backs up and writes. restore: a backup id.",
    ].join(" "),
    inputSchema: {
      project,
      psd: z.string(),
      skeleton: z.string().optional(),
      only: z.array(z.string()).optional(),
      placement: z.enum(["keep", "psd"]).optional(),
      grow: z.boolean().optional(),
      scale: z.number().positive().max(4).optional().describe("Image export scale"),
      preview: z.boolean().optional(),
      restore: z.string().optional(),
      apply: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, guarded(async (args) => {
    const { png, ...result } = await updateImages(config, cli, args as UpdateImagesOptions);
    if (result.mode === "updated" || result.mode === "restored") {
      recordStep(config, args.project, { tool: "spine_update_images", outcome: result.mode === "updated" ? "imagesUpdated" : "imagesRestored", detail: result.mode === "updated" ? `${result.changes.filter((c) => c.status !== "skipped").length} image(s) from ${args.psd}` : `images of ${args.restore}`, backupId: result.backup });
    }
    return json(result, png ? [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] : []);
  }));

  const num = z.number().optional();
  server.registerTool("spine_rig_edit", {
    title: "Rig edits into a new project",
    description: [
      "Adds bones, IK, physics, events and skins, sets setup poses, removes constraints, traces regions into meshes in place (meshRegion), copies meshes from another rig (copyMesh); written to a NEW .spine via JSON import (original untouched), listing what else the round trip changed. Dry-run by default; one skeleton.",
    ].join(" "),
    inputSchema: {
      project, output: z.string().describe("New .spine"),
      edits: z.array(z.discriminatedUnion("op", [
        z.object({ op: z.literal("addBone"), name: z.string(), parent: z.string(), x: num, y: num, rotation: num, length: num, scaleX: num, scaleY: num }),
        z.object({ op: z.literal("setBone"), name: z.string(), x: num, y: num, rotation: num, length: num, scaleX: num, scaleY: num, shearX: num, shearY: num }),
        z.object({ op: z.literal("addIk"), name: z.string(), bones: z.array(z.string()).min(1).max(2), target: z.string(), bendPositive: z.boolean().optional(), mix: num, softness: num, compress: z.boolean().optional(), stretch: z.boolean().optional() }),
        z.object({ op: z.literal("addPhysics"), name: z.string(), bone: z.string(), x: num, y: num, rotate: num, scaleX: num, shearX: num, inertia: num, strength: num, damping: num, mass: num, wind: num, gravity: num, mix: num }),
        z.object({ op: z.literal("addEvent"), name: z.string(), int: num, float: num, string: z.string().optional(), audio: z.string().optional(), volume: num, balance: num }),
        z.object({ op: z.literal("addSkin"), name: z.string(), from: z.string().optional() }),
        z.object({ op: z.literal("removeConstraint"), name: z.string() }),
        z.object({ op: z.literal("meshRegion"), slot: z.string(), attachment: z.string().optional() }),
        z.object({ op: z.literal("copyMesh"), from: z.string(), slot: z.string(), attachment: z.string().optional() }),
      ])).min(1),
      apply: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, guarded(async (args) => {
    const result = await rigEdit(config, cli, args as RigEditOptions);
    if (result.mode === "created") recordStep(config, args.output, { tool: "spine_rig_edit", outcome: "created", detail: `${args.edits.map((e) => `${e.op} ${"name" in e ? e.name : e.slot}`).join(", ").slice(0, 200)} from ${args.project}` });
    return json(result);
  }));

  server.registerTool("spine_list_backups", {
    title: "List project backups",
    description: "Backups made before writes (newest first), ids for spine_restore_backup.",
    inputSchema: { project },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ project: p }) => {
    assertInputPath(p, [".spine"]);
    const current = sha256File(p);
    return json({ project: p, backups: listBackups(config, p).map((b) => ({ ...b, sameAsCurrent: b.sha256 === current })) });
  }));

  server.registerTool("spine_restore_backup", {
    title: "Restore project backup",
    description: "Puts a backup back. Dry-run by default; apply backs up the current file first, then restores atomically.",
    inputSchema: { project, backupId: z.string(), apply: z.boolean().optional(), force: z.boolean().optional().describe("Even if open in Spine") },
    annotations: { readOnlyHint: false, destructiveHint: true },
  }, guarded(async ({ project: p, backupId, apply, force }) => {
    assertInputPath(p, [".spine"]);
    const entry = listBackups(config, p).find((b) => b.id === backupId);
    if (!entry) throw new UserError(`Backup "${backupId}" not found for ${p}. Use spine_list_backups.`);
    if (entry.sha256 === sha256File(p)) return json({ mode: "noop", note: "The project already matches this backup." });
    if (!apply) return json({ mode: "dry-run", restore: entry, note: "Call again with apply: true to restore. The current file is backed up first." });
    const open = editorStatus(config.spineBin, p);
    if (open.projectOpen === "likely" && !force) throw new UserError(`${p} looks open in the Spine editor (last project it opened). Close it there first, or pass force: true; ${EDITOR_OPEN_NOTE}`);
    const safety = createBackup(config, p, `before restore of ${backupId}`);
    restoreFile(entry, p);
    recordStep(config, p, { tool: "spine_restore_backup", outcome: "restored", detail: entry.reason, backupId: entry.id });
    return json({
      mode: "restored", restored: entry, safetyBackup: safety.id,
      notes: ["If this project is open in the Spine editor, reopen it.", `Undo with spine_restore_backup (backupId ${safety.id}).`],
    });
  }));

  const names = z.record(z.string(), z.string()).optional();
  server.registerTool("spine_transfer_animation", {
    title: "Transfer an animation to another skeleton",
    description: [
      "Copies an animation to another skeleton or project, matching names (exact, map, then case/separator-insensitive); reports what matched, renamed or could not move, then adds it like spine_add_animation (dry-run by default).",
      "copies: merge mode for animators on copies of one project: what each copy added or changed, conflicts (resolve with prefer), then writes into the base (to).",
    ].join(" "),
    inputSchema: {
      from: z.string().optional().describe(".spine or .json"),
      animation: z.string().optional(),
      copies: z.array(z.string()).min(1).max(20).optional(),
      prefer: z.record(z.string(), z.string()).optional().describe("animation -> copy"),
      fromSkeleton: z.string().optional(),
      to: z.string(),
      toSkeleton: z.string().optional(),
      name: z.string().optional(),
      map: z.object({ bones: names, slots: names, constraints: names, events: names, skins: names, attachments: names })
        .optional().describe('source -> target; attachments "slot/attachment"'),
      normalize: z.boolean().optional(),
      retarget: z.object({ translate: z.union([z.enum(["none", "skeleton", "parent"]), z.number().positive()]).optional() }).optional()
        .describe("Scale translate keys to the target"),
      apply: z.boolean().optional(),
      replace: z.boolean().optional(),
      editor, stagingPath, allowUpgrade,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, guarded(async ({ from, animation, copies, prefer, fromSkeleton, to, toSkeleton, name, map, normalize, retarget, apply, replace, editor: mode, stagingPath: sp, allowUpgrade: up }) => {
    assertInputPath(to, [".spine"]);
    if (copies?.length) {
      const base = pickSkeleton(await loadProject(config, cli, to), toSkeleton);
      const docs = [];
      for (const c of copies) { assertInputPath(c, [".spine", ".json"]); docs.push({ path: c, doc: pickSkeleton(await loadProject(config, cli, c), toSkeleton ?? base.name).doc }); }
      let plan;
      try { plan = mergePlan(base.doc, docs, prefer); } catch (e) { throw new UserError((e as Error).message); }
      const todo = plan.entries.filter((e) => e.from && (e.action === "add" || e.action === "change" || e.action === "conflict"));
      if (!apply) return json({ mode: "dry-run", merge: plan, toApply: todo.map((e) => `${e.action} ${e.animation} from ${e.from}`), note: "Call again with apply: true to write them into the base one by one (each backed up and verified)." });
      const written: unknown[] = [];
      for (const e of todo) {
        const copy = docs.find((d) => d.path === e.from)!;
        const rigChanged = plan.rigChanges.some((r) => r.copy === e.from);
        const src = copy.doc.animations![e.animation]!;
        const moved = rigChanged ? transferAnimation(src, copy.doc, base.doc, { map, normalize }) : { animation: src, report: null };
        const w = await addAnimation(config, cli, { project: to, skeleton: base.name, name: e.animation, animation: moved.animation, apply: true, replace: e.action !== "add", editor: mode, stagingPath: sp, allowUpgrade: up, trace: { tool: "spine_transfer_animation", detail: `merge ${e.animation} from ${e.from}` } });
        written.push({ animation: e.animation, action: e.action, from: e.from, mode: w.mode, verification: w.verification, ...(moved.report?.unmatched.length ? { unmatched: moved.report.unmatched.slice(0, 10) } : {}) });
      }
      return json({ mode: "applied", merge: plan, written });
    }
    if (!from || !animation) throw new UserError("Pass from and animation (or copies for a merge)");
    const src = pickSkeleton(await loadProject(config, cli, from), fromSkeleton);
    const dst = pickSkeleton(await loadProject(config, cli, to), toSkeleton);
    const anim = src.doc.animations?.[animation];
    if (!anim) throw new UserError(`Animation "${animation}" not found in ${src.name}. Available: ${Object.keys(src.doc.animations ?? {}).join(", ")}`);
    const { animation: moved, report } = transferAnimation(anim, src.doc, dst.doc, { map, normalize, retarget });
    if (!report.keysOut) throw new UserError(`Nothing matched: no key of "${animation}" has a counterpart in ${dst.name}. Unmatched: ${report.unmatched.slice(0, 10).map((u) => `${u.kind} ${u.name}`).join(", ")}. Pass map.`);
    const write = await addAnimation(config, cli, { project: to, skeleton: dst.name, name: name ?? animation, animation: moved, apply, replace, editor: mode, stagingPath: sp, allowUpgrade: up, trace: { tool: "spine_transfer_animation", detail: `${animation} from ${from}` } });
    return json({ transfer: { ...report, unmatched: report.unmatched.slice(0, 60), unmatchedTotal: report.unmatched.length }, ...write });
  }));
}
