import { execFileSync, findOnPath, removeQuiet } from "../platform.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { deriveAnimationWithNotes } from "./derive.js";
import { checkEventNames } from "./events.js";
import { projectFps, snapTime, tidyGenerated } from "./tidy.js";
import type { AnimationJson, Key, SkeletonJson } from "./types.js";

export interface LipSyncOptions {
  /** Absolute path to the dialogue (any format ffmpeg reads, or a video with sound). */
  audio: string;
  /** Mouth slot and its attachments from closed to widest open (two or more). */
  slot?: string;
  shapes?: string[];
  /** And/or a jaw bone that opens by rotation (degrees at the loudest). */
  jaw?: { bone: string; open: number };
  /** Key rate (default 24: mouths read best on twos at 12-24 fps). */
  fps?: number;
  start?: number;
  end?: number;
  /** Level (0-1 of the speech range) under which the mouth closes (default 0.12). */
  gate?: number;
  /** Shortest time a mouth shape is held, in frames (default 2). */
  hold?: number;
  /** auto (default): phonemes with Rhubarb Lip Sync when it is installed, else loudness; or force one. */
  mode?: "auto" | "phonemes" | "loudness";
  /** Rhubarb's mouth shapes (A-H, X) to attachments, when the mouth has those drawings; otherwise `shapes` are matched by openness. */
  cues?: Partial<Record<RhubarbShape, string>>;
  /** The spoken text: Rhubarb recognises the words better with it. */
  dialog?: string;
  /** english (default, word recognition) or other (phonetic recognition for any language). */
  language?: "english" | "other";
  /** An audio event the skeleton defines (its audio = the dialogue), keyed at the start so engines play it in sync. */
  audioEvent?: string;
}

/** Rhubarb's mouth shapes (Preston Blair set): A closed (M, B, P), B slightly open (most consonants), C open (EH),
 * D wide (AA), E rounded (AO, ER), F puckered (UW, OW, W), G teeth on lip (F, V), H tongue up (L), X rest. */
export type RhubarbShape = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "X";
/** How open each shape is (0 closed - 1 widest): picks among ordered shapes and drives a jaw. */
export const OPENNESS: Record<RhubarbShape, number> = { X: 0, A: 0, B: 0.25, G: 0.2, F: 0.3, H: 0.45, C: 0.55, E: 0.6, D: 1 };

/**
 * Rhubarb Lip Sync: RHUBARB_BIN, ~/.local/bin, ~/.local/share/rhubarb/<release>/ (Windows: %LOCALAPPDATA%\rhubarb\
 * <release>\rhubarb.exe), then the PATH.
 */
export function findRhubarb(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const home = homedir(), exe = platform === "win32" ? "rhubarb.exe" : "rhubarb";
  const share = platform === "win32" ? join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "rhubarb") : join(home, ".local", "share", "rhubarb");
  const candidates = [env.RHUBARB_BIN, ...(platform === "win32" ? [] : [join(home, ".local", "bin", "rhubarb")]),
    ...(existsSync(share) ? readdirSync(share).map((d) => join(share, d, exe)) : [])].filter((x): x is string => !!x);
  for (const c of candidates) if (existsSync(c)) return c;
  return findOnPath("rhubarb", platform, env);
}

/** Mouth cues from Rhubarb (the audio converted to 16 kHz mono WAV first, which Rhubarb needs). */
export function rhubarbCues(bin: string, file: string, o: { start?: number; end?: number; dialog?: string; language?: "english" | "other" } = {}): { start: number; end: number; value: RhubarbShape }[] {
  const dir = mkdtempSync(join(tmpdir(), "spine-mcp-rhubarb-"));
  try {
    const wav = join(dir, "in.wav");
    execFileSync("ffmpeg", ["-v", "error", "-ss", String(o.start ?? 0), ...(o.end !== undefined ? ["-to", String(o.end)] : []), "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
    const args = ["-f", "json", "-q", "--extendedShapes", "GHX", "-o", join(dir, "cues.json")];
    if (o.dialog) { writeFileSync(join(dir, "dialog.txt"), o.dialog); args.push("-d", join(dir, "dialog.txt")); }
    if (o.language === "other") args.push("-r", "phonetic");
    execFileSync(bin, [...args, wav], { maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 });
    return (JSON.parse(readFileSync(join(dir, "cues.json"), "utf8")) as { mouthCues: { start: number; end: number; value: RhubarbShape }[] }).mouthCues;
  } finally {
    removeQuiet(dir);
  }
}

/** Loudness per frame (RMS of 8 kHz mono), via ffmpeg. */
export function audioLevels(file: string, fps: number, start = 0, end?: number): number[] {
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-ss", String(start), ...(end !== undefined ? ["-to", String(end)] : []), "-i", file, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "-"], { maxBuffer: 512 * 1024 * 1024 });
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  const per = 8000 / fps, frames = Math.ceil(samples.length / per);
  const out: number[] = [];
  for (let f = 0; f < frames; f++) {
    const a = Math.floor(f * per), b = Math.min(samples.length, Math.floor((f + 1) * per));
    let s = 0;
    for (let i = a; i < b; i++) s += (samples[i]! / 32768) ** 2;
    out.push(b > a ? Math.sqrt(s / (b - a)) : 0);
  }
  return out;
}

const pct = (v: number[], p: number) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0; };

/**
 * Mouth shapes per frame from loudness: the speech range runs from the noise floor (20th percentile) to the loud end
 * (98th); under the gate the mouth is closed, above it the level picks a shape (or a jaw angle). Shapes shorter than
 * `hold` frames merge into their neighbour so the mouth does not flicker. Pure, for tests.
 */
export function mouthTrack(levels: number[], shapeCount: number, gate = 0.12, hold = 2): { shape: number[]; level: number[] } {
  const floor = pct(levels, 0.2), top = Math.max(pct(levels, 0.98), floor + 1e-6);
  const level = levels.map((v) => Math.max(0, Math.min(1, (v - floor) / (top - floor))));
  const shape = level.map((l) => (l < gate ? 0 : Math.min(shapeCount - 1, 1 + Math.floor(((l - gate) / (1 - gate)) * (shapeCount - 1)))));
  // Merge runs shorter than `hold` into the previous run (or the next at the start).
  for (let pass = 0; pass < 3; pass++) {
    let i = 0;
    while (i < shape.length) {
      let j = i;
      while (j < shape.length && shape[j] === shape[i]) j++;
      if (j - i < hold) { const v = i > 0 ? shape[i - 1]! : j < shape.length ? shape[j]! : shape[i]!; for (let k = i; k < j; k++) shape[k] = v; }
      i = j;
    }
  }
  return { shape, level };
}

/** A lip-sync animation from a dialogue file: attachment keys on a mouth slot and/or a jaw rotation. */
export function lipSync(skeleton: SkeletonJson, o: LipSyncOptions): { animation: AnimationJson; notes: string[] } {
  if (!isAbsolute(o.audio) || !existsSync(o.audio)) throw new Error(`audio must be an absolute path to an existing file: ${o.audio}`);
  if (!o.slot && !o.jaw) throw new Error("lipSync needs a mouth slot with shapes (closed to open) and/or a jaw bone");
  if (o.slot) {
    if (!(skeleton.slots ?? []).some((s) => s.name === o.slot)) throw new Error(`Unknown slot: ${o.slot}`);
    if (!o.cues && (!o.shapes || o.shapes.length < 2)) throw new Error("shapes needs two or more attachments, closed first, widest last (or cues: Rhubarb's A-H/X shapes to attachments)");
    const have = new Set((skeleton.skins ?? []).flatMap((sk) => Object.keys(sk.attachments?.[o.slot!] ?? {})));
    const unknown = (o.shapes ?? []).filter((n) => !have.has(n));
    if (unknown.length) throw new Error(`Not attachments of ${o.slot}: ${unknown.join(", ")}. It has: ${[...have].join(", ")}`);
  }
  if (o.jaw && !skeleton.bones.some((b) => b.name === o.jaw!.bone)) throw new Error(`Unknown bone: ${o.jaw.bone}`);
  const fps = o.fps ?? projectFps(skeleton);
  if (o.cues) {
    const have = new Set((skeleton.skins ?? []).flatMap((sk) => Object.keys(sk.attachments?.[o.slot ?? ""] ?? {})));
    const bad = Object.values(o.cues).filter((n) => n && !have.has(n));
    if (!o.slot || bad.length) throw new Error(`cues need a mouth slot with those attachments${bad.length ? `; not in ${o.slot}: ${bad.join(", ")}` : ""}`);
  }
  const rhubarb = o.mode === "loudness" ? null : findRhubarb();
  if (o.mode === "phonemes" && !rhubarb) throw new Error("Phoneme lip sync needs Rhubarb Lip Sync (https://github.com/DanielSWolf/rhubarb-lip-sync); install it or set RHUBARB_BIN, or use mode: loudness.");
  // One track for both modes: time, mouth (attachment name or shape index) and openness (0-1).
  let track: { time: number; open: number; shape: string; label: string }[];
  let duration: number, how: string;
  // Drawings closed to open: the given shapes, or the cue drawings ordered by how open their shape is.
  const list = o.shapes ?? (o.cues ? [...new Set((Object.entries(o.cues).filter(([, v]) => v) as [RhubarbShape, string][]).sort((x, y) => OPENNESS[x[0]] - OPENNESS[y[0]]).map(([, v]) => v))] : undefined);
  const n = list?.length ?? 4;
  const pick = (open: number) => list?.[Math.round(open * (n - 1))] ?? String(Math.round(open * (n - 1)));
  if (rhubarb) {
    const cues = rhubarbCues(rhubarb, o.audio, { start: o.start, end: o.end, dialog: o.dialog, language: o.language });
    if (!cues.length) throw new Error("Rhubarb found no speech in the file");
    // Keys land on frames; a cue shorter than `hold` frames merges into the one before (mouths read best held).
    const minLen = (o.hold ?? 2) / fps;
    const kept: typeof cues = [];
    for (const c of cues) { const last = kept[kept.length - 1]; if (last && c.end - c.start < minLen) last.end = c.end; else kept.push({ ...c }); }
    // A shape the cues leave out takes the given cue that opens the mouth most alike.
    const given = Object.entries(o.cues ?? {}).filter(([, v]) => v) as [RhubarbShape, string][];
    const nearest = (v: RhubarbShape) => given.reduce((a, b) => (Math.abs(OPENNESS[b[0]] - OPENNESS[v]) < Math.abs(OPENNESS[a[0]] - OPENNESS[v]) ? b : a))[1];
    const mouth = (v: RhubarbShape) => o.cues?.[v] ?? (given.length && !o.shapes ? nearest(v) : pick(OPENNESS[v] ?? 0));
    track = kept.map((c) => ({ time: Math.round(c.start * fps) / fps, open: OPENNESS[c.value] ?? 0, shape: mouth(c.value), label: c.value }));
    // The last cue ends on Rhubarb's 0.01 s grid: the animation ends on the frame after it.
    duration = Math.ceil(cues[cues.length - 1]!.end * fps - 1e-6) / fps;
    how = `phonemes (Rhubarb Lip Sync${o.dialog ? ", with the dialog text" : ""}${o.language === "other" ? ", phonetic" : ""})`;
  } else {
    const levels = audioLevels(o.audio, fps, o.start ?? 0, o.end);
    if (!levels.length) throw new Error("No audio found in the file");
    const { shape } = mouthTrack(levels, n, o.gate ?? 0.12, o.hold ?? 2);
    track = shape.map((sh, f) => ({ time: f / fps, open: sh / Math.max(1, n - 1), shape: list?.[sh] ?? String(sh), label: String(sh) }));
    duration = levels.length / fps;
    how = "loudness";
  }
  // Consecutive frames with the same mouth collapse into one key.
  const changes = track.filter((t, i) => i === 0 || t.shape !== track[i - 1]!.shape || Math.abs(t.open - track[i - 1]!.open) > 1e-6);
  // Key times with six decimals, like the other generators: Spine samples four-decimal times differently on import (G84).
  const t6 = (t: number) => snapTime(t, fps);
  const anim: AnimationJson = {};
  if (o.slot) {
    // An empty cue hides the mouth: a key without a name (Spine's import changes an empty name, G112).
    const named = (shape: string): Key => (shape ? { name: shape } : {});
    const keys: Key[] = changes.map((t, i) => (i === 0 ? named(t.shape) : { time: t6(t.time), ...named(t.shape) }));
    keys.push({ time: t6(duration), ...named(changes[changes.length - 1]!.shape) });
    anim.slots = { [o.slot]: { attachment: keys.filter((k, i) => i === keys.length - 1 || (keys[i + 1]!.time ?? 0) !== (k.time ?? 0)) } };
  }
  if (o.jaw) {
    // The jaw follows the mouth's openness, easing into each new shape over half a frame.
    const value = (open: number) => o.jaw!.open * open;
    const keys: Key[] = [{ value: value(changes[0]!.open) }];
    for (let i = 1; i < changes.length; i++) keys.push({ time: t6(Math.max(0, changes[i]!.time - 1 / fps)), value: value(changes[i - 1]!.open) }, { time: t6(changes[i]!.time), value: value(changes[i]!.open) });
    keys.push({ time: t6(duration), value: value(changes[changes.length - 1]!.open) });
    anim.bones = { [o.jaw.bone]: { rotate: keys.filter((k, i) => i === keys.length - 1 || (keys[i + 1]!.time ?? 0) !== (k.time ?? 0)) } };
  }
  if (o.audioEvent) {
    checkEventNames(skeleton, [o.audioEvent]);
    anim.events = [{ name: o.audioEvent }];
  }
  const r = tidyGenerated({ animation: o.jaw ? deriveAnimationWithNotes(anim, [{ op: "ease", easing: "easeInOutSine", bones: [o.jaw.bone] }], { skeleton }).animation : anim, notes: [] as string[] }, fps, [o.jaw?.open]).animation;
  const counts = new Map<string, number>();
  for (const c of changes) counts.set(c.label, (counts.get(c.label) ?? 0) + 1);
  return {
    animation: r,
    notes: [
      `${duration.toFixed(2)}s of audio by ${how}: ${changes.length} mouth changes (${[...counts].map(([k, v]) => `${k}: ${v}`).join(", ")}).`,
      rhubarb
        ? (o.cues ? "Rhubarb's shapes mapped to your drawings." : `Rhubarb's shapes (A-H, X) matched to your ${n} drawings by how open they are; pass cues ({A: "mbp", D: "aa", ...}) when the mouth has the Preston Blair set.`)
        : "Loudness only: open and closed track the voice, but vowels and consonants are not told apart (install Rhubarb Lip Sync for phonemes).",
      "Play the audio from your engine in sync, or add it as an event in Spine.",
    ],
  };
}
