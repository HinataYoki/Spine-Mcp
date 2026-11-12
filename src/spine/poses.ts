// Pose library and blocking from poses: poses sampled from existing animations, kept per project, laid out pose to pose.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { deriveAnimationWithNotes } from "./derive.js";
import { loadSkeletonData, spine } from "./runtime.js";
import { timingReport } from "./timing.js";
import { projectFps, snapTime, tidyAnimation, toFourDecimals } from "./tidy.js";
import type { AnimationJson, Key, SkeletonJson } from "./types.js";
import { fileKeyOr } from "../platform.js";

/** A pose: each bone's offset from its setup pose (rotation, translation, scale ratio, shear) and slot attachments. */
export interface Pose {
  from?: string;
  bones: Record<string, { rotate: number; x: number; y: number; scaleX: number; scaleY: number; shearX: number; shearY: number }>;
  slots: Record<string, string | null>;
}

export interface PoseRef {
  time: number;
  /** "animation@seconds" (sampled now) or the name of a saved pose. */
  pose: string;
}

const r = toFourDecimals;

/** The pose an animation shows at a time, as offsets from the setup pose (only what differs). */
export function samplePose(skeleton: SkeletonJson, animation: string, time: number): Pose {
  const data = loadSkeletonData(skeleton);
  const anim = data.findAnimation(animation);
  if (!anim) throw new Error(`Animation "${animation}" not found. Animations: ${data.animations.map((a) => a.name).join(", ")}`);
  if (time < 0 || time > anim.duration + 1e-6) throw new Error(`${animation} is ${anim.duration}s long; ${time}s is outside it`);
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  anim.apply(sk, time, time, false, null, 1, spine.MixFrom.setup, false, false, false);
  const pose: Pose = { from: `${animation}@${time}`, bones: {}, slots: {} };
  for (const b of sk.bones) {
    const p = b.pose, s = b.data.setupPose;
    const v = { rotate: r(p.rotation - s.rotation), x: r(p.x - s.x), y: r(p.y - s.y), scaleX: r(s.scaleX ? p.scaleX / s.scaleX : 1), scaleY: r(s.scaleY ? p.scaleY / s.scaleY : 1), shearX: r(p.shearX - s.shearX), shearY: r(p.shearY - s.shearY) };
    if (v.rotate || v.x || v.y || v.scaleX !== 1 || v.scaleY !== 1 || v.shearX || v.shearY) pose.bones[b.data.name] = v;
  }
  for (const sl of sk.slots) {
    const now = sl.pose.getAttachment()?.name ?? null;
    if (now !== (sl.data.attachmentName ?? null)) pose.slots[sl.data.name] = now;
  }
  return pose;
}

const libraryFile = (config: Config, project: string) => {
  const id = createHash("sha1").update(fileKeyOr(project)).digest("hex").slice(0, 16);
  return join(config.workDir, "poses", `${id}.json`);
};

/** Saved poses of a project (kept in spine-mcp's work folder, never in the project). */
export function loadLibrary(config: Config, project: string): Record<string, Pose> {
  const f = libraryFile(config, project);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { poses: Record<string, Pose> }).poses : {};
}

export function savePoses(config: Config, project: string, skeleton: SkeletonJson, items: { name: string; from: string }[]): string[] {
  const lib = loadLibrary(config, project);
  for (const it of items) {
    if (!/^[\w .-]+$/.test(it.name)) throw new Error(`Pose name must be letters, digits, space, dot or dash: ${it.name}`);
    lib[it.name] = resolvePose(skeleton, it.from, {});
  }
  const f = libraryFile(config, project);
  mkdirSync(join(config.workDir, "poses"), { recursive: true });
  writeFileSync(f, JSON.stringify({ project, poses: lib }, null, 2));
  return Object.keys(lib);
}

export function resolvePose(skeleton: SkeletonJson, ref: string, library: Record<string, Pose>): Pose {
  if (library[ref]) return library[ref]!;
  const m = /^(.+)@([\d.]+)$/.exec(ref);
  if (!m) throw new Error(`Pose "${ref}" is neither a saved pose (${Object.keys(library).join(", ") || "none saved"}) nor "animation@seconds"`);
  return samplePose(skeleton, m[1]!, Number(m[2]));
}

/** Key poses of every animation (times many timelines key together), as "animation@time" references to start from. */
export function poseCandidates(skeleton: SkeletonJson, max = 8): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, anim] of Object.entries(skeleton.animations ?? {})) {
    const rep = timingReport(name, anim);
    out[name] = rep.keyPoses.sort((a, b) => b[1] - a[1]).slice(0, max).map(([t]) => `${name}@${t}`).sort((a, b) => Number(a.split("@")[1]) - Number(b.split("@")[1]));
  }
  return out;
}

export interface BlockingOptions {
  poses: PoseRef[];
  /** Total length (default: last pose + 0.5 s). With loop (default true) the first pose returns at the end. */
  duration?: number;
  loop?: boolean;
  /** false (default): stepped blocking; true or a smoothness (0-1): splined with automatic tangents. */
  spline?: boolean | number;
}

/**
 * A pose-to-pose animation: every bone or slot any pose touches is keyed at every pose (untouched ones at setup), so
 * each pose reads exactly as sampled. Stepped by default (blocking), or splined.
 */
export function blockingFromPoses(skeleton: SkeletonJson, o: BlockingOptions, library: Record<string, Pose>): { animation: AnimationJson; notes: string[] } {
  if (o.poses.length < 1) throw new Error("blocking needs poses ([{time, pose}])");
  const fps = projectFps(skeleton);
  const refs = [...o.poses].map((p) => ({ ...p, time: snapTime(p.time, fps) })).sort((a, b) => a.time - b.time);
  if (refs[0]!.time !== 0) refs.unshift({ time: 0, pose: refs[0]!.pose });
  const poses = refs.map((p) => ({ time: p.time, pose: resolvePose(skeleton, p.pose, library), name: p.pose }));
  const loop = o.loop ?? true;
  const end = snapTime(o.duration ?? poses[poses.length - 1]!.time + 0.5, fps);
  if (end < poses[poses.length - 1]!.time) throw new Error(`duration ${end}s ends before the last pose (${poses[poses.length - 1]!.time}s)`);
  // A loop returns to the first pose at the end, unless a pose already sits there (two keys at one time: Spine merges them).
  const closed = loop && poses[poses.length - 1]!.time < end;
  const keyed = closed ? [...poses, { time: end, pose: poses[0]!.pose, name: poses[0]!.name }] : poses;
  const bones = [...new Set(poses.flatMap((p) => Object.keys(p.pose.bones)))];
  const slots = [...new Set(poses.flatMap((p) => Object.keys(p.pose.slots)))];
  const setupSlot = new Map((skeleton.slots ?? []).map((s) => [s.name, s.attachment ?? null]));
  const zero = { rotate: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 };
  const anim: AnimationJson = { bones: {}, slots: {} };
  for (const b of bones) {
    const at = (p: Pose) => p.bones[b] ?? zero;
    const tl: Record<string, Key[]> = {
      rotate: keyed.map((p) => ({ ...(p.time ? { time: r(p.time) } : {}), value: at(p.pose).rotate })),
      translate: keyed.map((p) => ({ ...(p.time ? { time: r(p.time) } : {}), x: at(p.pose).x, y: at(p.pose).y })),
    };
    if (keyed.some((p) => at(p.pose).scaleX !== 1 || at(p.pose).scaleY !== 1)) tl.scale = keyed.map((p) => ({ ...(p.time ? { time: r(p.time) } : {}), x: at(p.pose).scaleX, y: at(p.pose).scaleY }));
    if (keyed.some((p) => at(p.pose).shearX || at(p.pose).shearY)) tl.shear = keyed.map((p) => ({ ...(p.time ? { time: r(p.time) } : {}), x: at(p.pose).shearX, y: at(p.pose).shearY }));
    // Drop channels that never move.
    if (tl.rotate!.every((k) => k.value === 0)) delete tl.rotate;
    if (tl.translate!.every((k) => k.x === 0 && k.y === 0)) delete tl.translate;
    if (Object.keys(tl).length) anim.bones![b] = tl;
  }
  for (const sl of slots) {
    const keys: Key[] = keyed.map((p) => ({ ...(p.time ? { time: r(p.time) } : {}), name: sl in p.pose.slots ? p.pose.slots[sl]! : setupSlot.get(sl) ?? null }));
    anim.slots![sl] = { attachment: keys.filter((k, i) => i === 0 || k.name !== keys[i - 1]!.name) };
  }
  const spline = o.spline === true ? 1 : typeof o.spline === "number" ? o.spline : null;
  const r2 = deriveAnimationWithNotes(tidyAnimation(anim, fps, { values: false }).animation, spline === null ? [{ op: "blocking" }] : [{ op: "spline", smoothness: spline }], { skeleton });
  return {
    animation: r2.animation,
    notes: [
      `${poses.length} pose(s) over ${end}s${closed ? " (back to the first at the end)" : ""}: ${poses.map((p) => `${p.time}s ${p.name}`).join(", ")}; ${bones.length} bone(s), ${slots.length} slot(s) keyed at every pose.`,
      spline === null ? "Stepped (blocking): review the poses and timing, then the spline op (or spline: true here) turns it into motion." : r2.notes.join(" "),
      `Poses on whole frames at ${fps} fps; their values stay as sampled from the source animations.`,
    ],
  };
}
