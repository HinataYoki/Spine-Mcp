import { angleDelta } from "./measure.js";
import { keyTime } from "./curves.js";
import { iterateTimelines } from "./inspect.js";
import { spine } from "./runtime.js";
import { missingTimelines } from "./setupkeys.js";
import type { AnimationJson, SkeletonJson } from "./types.js";

export interface Transition {
  from: string;
  to: string;
  /** Mix duration in seconds (default `defaultMix`; mix durations live in game code, not in skeleton data). */
  mix?: number;
}

export interface MixCheckOptions {
  /** Transitions to test; default: every ordered pair of animations longer than 0 (capped). */
  transitions?: Transition[];
  defaultMix?: number;
  /** Track the transitions play on; with `base`, track 0 plays `base` underneath (layered setups). */
  track?: number;
  base?: string;
  /** Switch points as fractions of `from`'s duration (default 0.25, 0.5, 0.75, 1). */
  at?: number[];
  fps?: number;
  bones?: string[];
  /** Max transitions when testing all pairs (default 120). */
  limit?: number;
  /**
   * animationState (default): spine-core's AnimationState, as SkeletonAnimation plays it. mecanim: spine-unity's
   * SkeletonMecanim with its defaults (autoReset, MixNext on layer 0): the outgoing clip at full weight through the
   * transition, the incoming one mixed in by the transition weight, and whatever the outgoing clip keyed reset to the
   * setup pose once it stops applying. `mix` is the transition duration in seconds.
   */
  runtime?: "animationState" | "mecanim";
  /** runtime mecanim: the layer's MixMode (default mixNext) and MecanimTranslator.autoReset (default true). */
  mecanimMode?: MecanimMode;
  autoReset?: boolean;
  /** The outgoing TrackEntry's eventThreshold (default 0, the runtimes' default: its events are not fired during the mix). */
  eventThreshold?: number;
  /** A bone whose world position per frame is returned for each transition at the first switch point (to plot it). */
  trace?: string;
}

/** spine-unity's SkeletonMecanim.MecanimTranslator.MixMode, per Animator layer. */
export type MecanimMode = "mixNext" | "alwaysMix" | "hard" | "match";

export interface MixPop {
  bone: string;
  kind: "position" | "rotation";
  /** Seconds after the switch. */
  time: number;
  step: number;
  /** The larger of the steps just before and after: a pop stands out from them. */
  neighbours: number;
  /** Largest step this bone makes in either animation on its own. */
  baseline: number;
  /** When it happens relative to the mix. */
  phase: "switch" | "during mix" | "mix end" | "after mix";
  /** Likely cause, when one is found in the data. */
  cause?: string;
}

export interface TransitionResult {
  from: string;
  to: string;
  mix: number;
  ok: boolean;
  /** Worst pop per switch point (only switch points with pops). */
  pops: (MixPop & { at: number })[];
  /** Events of the outgoing animation inside the mix window that never fire (eventThreshold): footsteps, sounds. */
  lostEvents: LostEvent[];
  /** runtime mecanim: bones that still differ from the incoming animation once the transition is over (autoReset off
   * leaves what only the outgoing clip keyed at its last pose). */
  held?: { bone: string; position: number; rotation: number }[];
  /** With trace: the bone's world position per frame from just before the first switch point. */
  trace?: { bone: string; fps: number; switchFrame: number; points: [number, number][] };
}

export interface LostEvent {
  event: string;
  /** Key time in the outgoing animation. */
  time: number;
  /** Switch point (fraction of the outgoing animation). */
  at: number;
}

export interface LateKey {
  animation: string;
  timeline: string;
  firstKey: number;
}

export interface MixCheckResult {
  fps: number;
  track: number;
  base: string | null;
  tested: number;
  failing: number;
  transitions: TransitionResult[];
  /** Timelines whose first key is after 0: on a higher track (or after Animation clean up) the property keeps the
   * lower track's / previous value until that key, then jumps. */
  lateFirstKeys: LateKey[];
  /** With `base`: pops inside an animation while it plays over the base (e.g. a late first key jumping over it). */
  layeredPops: { animation: string; bone: string; kind: MixPop["kind"]; time: number; step: number; neighbours: number }[];
  /** runtime mecanim: per incoming animation, timelines the others key and it does not (they snap at the end of a
   * transition; the setupKeys derive op adds them). */
  mecanimMissingKeys?: { animation: string; timelines: number; examples: string[] }[];
  runtime: "animationState" | "mecanim";
  notes: string[];
}

const POS_MIN = 1, ROT_MIN = 3; // a pop must also be visible: at least 1 unit or 3 degrees in one frame
const FACTOR = 1.5; // ...more than the bone's largest step inside either animation
const SPIKE = 3; // ...and at least 3x the steps of the frames before and after it

type Frame = Float64Array; // [x, y, rotation] per bone

type FiredEvent = { animation: string; name: string; time: number; frame: number };
type RunOptions = { track: number; base?: string; first: string; second?: string; switchAt?: number; mix: number; seconds: number; fps: number; mixes?: Map<string, number>; runtime?: "animationState" | "mecanim"; mecanimMode?: MecanimMode; autoReset?: boolean; eventThreshold?: number; events?: FiredEvent[] };

function capture(sk: spine.Skeleton): Frame {
  const f = new Float64Array(sk.bones.length * 3);
  sk.bones.forEach((b, i) => {
    const p = b.appliedPose;
    f[i * 3] = p.worldX;
    f[i * 3 + 1] = p.worldY;
    f[i * 3 + 2] = p.getWorldRotationX();
  });
  return f;
}

/**
 * SkeletonMecanim.MecanimTranslator.Apply (one clip per state, layer 0; default autoReset and MixNext), frame ordering
 * as in Unity: the transition starts on the switch frame and that frame's Animator update already advances it.
 */
export function mecanimFrames(data: spine.SkeletonData, o: { first: string; second: string; switchAt: number; mix: number; seconds: number; fps: number; mecanimMode?: MecanimMode; autoReset?: boolean }): Frame[] {
  return runMecanim(data, { ...o, track: 0 });
}

const WEIGHT_EPSILON = 0.0001; // MecanimTranslator.WeightEpsilon

function runMecanim(data: spine.SkeletonData, o: RunOptions): Frame[] {
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  const a = data.findAnimation(o.first)!, b = o.second ? data.findAnimation(o.second)! : null;
  const dt = 1 / o.fps, total = Math.round(o.seconds * o.fps);
  const switchFrame = o.switchAt === undefined || !b ? Number.POSITIVE_INFINITY : Math.round(o.switchAt * o.fps);
  let previous: spine.Animation[] = [];
  const frames: Frame[] = [];
  const mode = o.mecanimMode ?? "mixNext";
  for (let k = 0; k <= total; k++) {
    // Clear previous (autoReset): everything the clips applied last frame goes back to the setup pose.
    if (o.autoReset !== false) for (const p of previous) p.apply(sk, 0, 0, false, null, 0, spine.MixFrom.setup, false, true, false);
    const applied: spine.Animation[] = [];
    // Measured against Unity: on the switch frame the transition weight already advances one step while the incoming
    // state's time starts at 0.
    const since = (k - switchFrame) * dt;
    const w = k < switchFrame ? 0 : o.mix > 0 ? Math.min(1, (since + dt) / o.mix) : 1;
    // Unity's clip weights are 1 - w (current state) and w (next state). The first clip applied comes from the setup
    // pose, later ones mix over it. MixNext and Hard apply the current clip at full weight, Hard the next one too;
    // AlwaysMix uses the weights as they are; Match resolves them to lerp weights, which for one clip per state are
    // MixNext's.
    const apply = (anim: spine.Animation, t: number, unityWeight: number, alpha: number) => {
      if (unityWeight < WEIGHT_EPSILON) return;
      anim.apply(sk, 0, t, true, null, alpha, applied.length ? spine.MixFrom.first : spine.MixFrom.setup, false, false, false);
      applied.push(anim);
    };
    if (w < 1) {
      apply(a, k * dt, 1 - w, mode === "alwaysMix" ? 1 - w : 1);
      if (b) apply(b, since, w, mode === "hard" ? 1 : w);
    } else {
      apply(b!, since, 1, 1);
    }
    previous = applied;
    sk.updateWorldTransform(spine.Physics.none);
    frames.push(capture(sk));
  }
  return frames;
}

function runState(data: spine.SkeletonData, o: RunOptions): Frame[] {
  if (o.runtime === "mecanim") return runMecanim(data, o);
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  const sd = new spine.AnimationStateData(data);
  sd.defaultMix = o.mix;
  const state = new spine.AnimationState(sd);
  if (o.base) state.setAnimation(0, o.base, true);
  const firstEntry = state.setAnimation(o.track, o.first, true);
  if (o.eventThreshold !== undefined) firstEntry.eventThreshold = o.eventThreshold;
  let frame = 0;
  if (o.events) state.addListener({ event: (entry: spine.TrackEntry, e: spine.Event) => { o.events!.push({ animation: entry.animation!.name, name: e.data.name, time: +e.time.toFixed(4), frame }); } } as spine.AnimationStateListener);
  const dt = 1 / o.fps;
  const frames: Frame[] = [];
  const total = Math.round(o.seconds * o.fps);
  const switchFrame = o.switchAt === undefined ? -1 : Math.round(o.switchAt * o.fps);
  for (let k = 0; k <= total; k++) {
    frame = k;
    if (k === switchFrame && o.second) {
      const entry = state.setAnimation(o.track, o.second, true);
      entry.mixDuration = o.mix;
    }
    // Like a game loop (e.g. spine-unity's SkeletonAnimation): no setup-pose reset per frame, AnimationState's mix
    // modes depend on the pose the skeleton keeps.
    if (k > 0) state.update(dt);
    state.apply(sk);
    sk.updateWorldTransform(spine.Physics.none);
    frames.push(capture(sk));
  }
  return frames;
}

/** Largest per-frame position and rotation step of each bone. */
function maxSteps(frames: Frame[], bones: number): Float64Array {
  const out = new Float64Array(bones * 2);
  for (let k = 1; k < frames.length; k++) {
    for (let i = 0; i < bones; i++) {
      const a = frames[k - 1]!, b = frames[k]!;
      out[i * 2] = Math.max(out[i * 2]!, Math.hypot(b[i * 3]! - a[i * 3]!, b[i * 3 + 1]! - a[i * 3 + 1]!));
      out[i * 2 + 1] = Math.max(out[i * 2 + 1]!, Math.abs(angleDelta(a[i * 3 + 2]!, b[i * 3 + 2]!)));
    }
  }
  return out;
}

/**
 * Plays transitions with spine-core's AnimationState (as a game does) and reports frames where a bone jumps more than
 * it ever moves inside either animation: pops caused by the mix itself, by properties one animation keys and the other
 * does not, or by keys that start after 0 on layered tracks.
 */
export function mixCheck(data: spine.SkeletonData, animations: Record<string, AnimationJson>, o: MixCheckOptions = {}): MixCheckResult {
  if (o.runtime !== "mecanim" && (o.mecanimMode || o.autoReset !== undefined)) throw new Error("mecanimMode and autoReset need runtime mecanim");
  const fps = o.fps ?? 60;
  const track = o.track ?? 0;
  const defaultMix = o.defaultMix ?? 0.2;
  const at = o.at?.length ? o.at : [0.25, 0.5, 0.75, 1];
  const notes: string[] = [];
  if (o.base && track === 0) throw new Error("base needs track >= 1 (the base animation plays on track 0)");
  const runtime = o.runtime ?? "animationState";
  const traceIdx = o.trace ? data.bones.findIndex((b) => b.name === o.trace) : -1;
  if (o.trace && traceIdx < 0) throw new Error(`trace: bone "${o.trace}" not found`);
  if (runtime === "mecanim" && (o.base || track)) throw new Error("runtime mecanim simulates one Animator layer (layer 0): leave out base and track");
  const names = data.animations.filter((a) => a.duration > 0 && a.name !== o.base).map((a) => a.name);
  let transitions: Transition[] = o.transitions ?? names.flatMap((a) => names.filter((b) => b !== a).map((b) => ({ from: a, to: b })));
  const limit = o.limit ?? 120;
  if (!o.transitions && transitions.length > limit) {
    notes.push(`${transitions.length} pairs; tested the first ${limit} (pass transitions or limit to choose)`);
    transitions = transitions.slice(0, limit);
  }
  for (const t of transitions) for (const n of [t.from, t.to]) if (!data.findAnimation(n)) throw new Error(`Animation "${n}" not found`);
  const boneIdx = o.bones?.length ? o.bones.map((b) => {
    const i = data.bones.findIndex((d) => d.name === b);
    if (i < 0) throw new Error(`Bone "${b}" not found`);
    return i;
  }) : data.bones.map((_, i) => i);
  // Physics-driven and root bones are left to the simulation / game code.
  const physics = new Set(data.constraints.filter((c) => c instanceof spine.PhysicsConstraintData).map((c) => (c as spine.PhysicsConstraintData).bone.name));
  const checked = boneIdx.filter((i) => !physics.has(data.bones[i]!.name));
  if (physics.size) notes.push(`physics-driven bones skipped (simulation off): ${[...physics].join(", ")}`);

  const baselines = new Map<string, Float64Array>();
  const layeredPops: MixCheckResult["layeredPops"] = [];
  const baseline = (name: string) => {
    if (!baselines.has(name)) {
      const d = data.findAnimation(name)!.duration;
      const frames = runState(data, { track, base: o.base, first: name, mix: 0, seconds: d * 2, fps, runtime });
      baselines.set(name, maxSteps(frames, data.bones.length));
      if (o.base) {
        // Second cycle only: the first frames blend in from the setup pose.
        const from = Math.round(d * fps) + 1;
        let worst: MixCheckResult["layeredPops"][number] | null = null;
        for (let k = Math.max(2, from); k < frames.length - 1; k++) {
          for (const i of checked) {
            for (const kind of ["position", "rotation"] as const) {
              const st = (j: number) => {
                const a = frames[j - 1]!, b = frames[j]!;
                return kind === "position" ? Math.hypot(b[i * 3]! - a[i * 3]!, b[i * 3 + 1]! - a[i * 3 + 1]!) : Math.abs(angleDelta(a[i * 3 + 2]!, b[i * 3 + 2]!));
              };
              const s0 = st(k), nb = Math.max(st(k - 1), st(k + 1));
              if (s0 > SPIKE * nb && s0 > (kind === "position" ? POS_MIN : ROT_MIN) && (!worst || s0 > worst.step)) {
                worst = { animation: name, bone: data.bones[i]!.name, kind, time: +((k - from + 1) / fps).toFixed(3), step: +s0.toFixed(2), neighbours: +nb.toFixed(2) };
              }
            }
          }
        }
        if (worst) layeredPops.push(worst);
      }
    }
    return baselines.get(name)!;
  };

  const results: TransitionResult[] = transitions.map((t) => {
    const from = data.findAnimation(t.from)!, to = data.findAnimation(t.to)!;
    const mix = t.mix ?? defaultMix;
    const bf = baseline(t.from), bt = baseline(t.to);
    const pops: (MixPop & { at: number })[] = [];
    const lostEvents: LostEvent[] = [];
    const held: NonNullable<TransitionResult["held"]> = [];
    let traceOut: TransitionResult["trace"];
    for (const frac of at) {
      const switchAt = from.duration * frac;
      // One full cycle of `from` first (its own start is not part of the transition), then the switch.
      const lead = from.duration;
      const seconds = lead + switchAt + mix + Math.max(0.3, Math.min(to.duration, 1));
      const fired: FiredEvent[] = [];
      const frames = runState(data, { track, base: o.base, first: t.from, second: t.to, switchAt: lead + switchAt, mix, seconds, fps, runtime, mecanimMode: o.mecanimMode, autoReset: o.autoReset, eventThreshold: o.eventThreshold, events: fired });
      const start = Math.round((lead + switchAt) * fps);
      if (traceIdx >= 0 && frac === at[0] && !traceOut) {
        const from0 = Math.max(0, start - 6);
        traceOut = { bone: o.trace!, fps, switchFrame: start - from0, points: frames.slice(from0).map((f) => [+f[traceIdx * 3]!.toFixed(3), +f[traceIdx * 3 + 1]!.toFixed(3)] as [number, number]) };
      }
      if (runtime === "animationState" && mix > 0 && from.timelines.some((tl) => tl instanceof spine.EventTimeline)) {
        // What the outgoing animation fires on its own over the mix window, against what the transition fires.
        const alone: FiredEvent[] = [];
        runState(data, { track, base: o.base, first: t.from, mix, seconds, fps, events: alone });
        const end = start + Math.round(mix * fps);
        const got = new Set(fired.filter((e) => e.animation === t.from).map((e) => `${e.frame}|${e.name}|${e.time}`));
        for (const e of alone) {
          if (e.animation !== t.from || e.frame < start || e.frame > end || got.has(`${e.frame}|${e.name}|${e.time}`)) continue;
          if (!lostEvents.some((l) => l.event === e.name && l.time === e.time && l.at === +frac.toFixed(2))) lostEvents.push({ event: e.name, time: e.time, at: +frac.toFixed(2) });
        }
      }
      let worst: (MixPop & { at: number }) | null = null;
      // Per-frame steps of each checked bone from just before the switch to the end of the window.
      const step = (k: number, i: number, kind: MixPop["kind"]) => {
        const a = frames[k - 1]!, b = frames[k]!;
        return kind === "position" ? Math.hypot(b[i * 3]! - a[i * 3]!, b[i * 3 + 1]! - a[i * 3 + 1]!) : Math.abs(angleDelta(a[i * 3 + 2]!, b[i * 3 + 2]!));
      };
      for (let k = Math.max(2, start - 1); k < frames.length - 1; k++) {
        for (const i of checked) {
          for (const kind of ["position", "rotation"] as const) {
            const s0 = step(k, i, kind), prev = step(k - 1, i, kind), next = step(k + 1, i, kind);
            const base = Math.max(bf[i * 2 + (kind === "rotation" ? 1 : 0)]!, bt[i * 2 + (kind === "rotation" ? 1 : 0)]!);
            // A pop is a discontinuity: one frame jumps far more than the frames around it (a fast but smooth mix is
            // not), more than the bone ever jumps inside either animation, and enough to see.
            const spike = s0 > SPIKE * Math.max(prev, next);
            if (spike && s0 > (kind === "position" ? POS_MIN : ROT_MIN) && s0 > FACTOR * base) {
              const score = s0 / Math.max(prev, next, 1e-6);
              if (!worst || score > worst.step / Math.max(worst.neighbours, 1e-6)) {
                const time = (k - start) / fps;
                const phase = k <= start ? "switch" : Math.abs(time - mix) <= 1.5 / fps ? "mix end" : time < mix ? "during mix" : "after mix";
                worst = { bone: data.bones[i]!.name, kind, time: +time.toFixed(3), step: +s0.toFixed(2), neighbours: +Math.max(prev, next).toFixed(2), baseline: +base.toFixed(2), phase, at: +frac.toFixed(2) };
              }
            }
          }
        }
      }
      if (runtime === "mecanim") {
        // Once the transition is over only the incoming clip plays: compare the last frame with it alone over setup.
        const ref = new spine.Skeleton(data);
        ref.setupPose();
        to.apply(ref, 0, (frames.length - 1 - start) / fps, true, null, 1, spine.MixFrom.setup, false, false, false);
        ref.updateWorldTransform(spine.Physics.none);
        const last = frames[frames.length - 1]!, want = capture(ref);
        for (const i of checked) {
          const position = Math.hypot(last[i * 3]! - want[i * 3]!, last[i * 3 + 1]! - want[i * 3 + 1]!), rotation = Math.abs(angleDelta(last[i * 3 + 2]!, want[i * 3 + 2]!));
          if (position <= POS_MIN && rotation <= ROT_MIN) continue;
          const name = data.bones[i]!.name, h = held.find((x) => x.bone === name);
          if (h) { h.position = Math.max(h.position, +position.toFixed(2)); h.rotation = Math.max(h.rotation, +rotation.toFixed(2)); } else held.push({ bone: name, position: +position.toFixed(2), rotation: +rotation.toFixed(2) });
        }
      }
      if (worst) {
        const cause = runtime === "mecanim" ? mecanimCause(data, animations, t.from, t.to, worst.bone) ?? popCause(data, animations, t.from, t.to, worst.bone, worst.phase) : popCause(data, animations, t.from, t.to, worst.bone, worst.phase);
        pops.push(cause ? { ...worst, cause } : worst);
      }
    }
    held.sort((x, y) => y.position - x.position || y.rotation - x.rotation);
    return { from: t.from, to: t.to, mix, ok: pops.length === 0 && held.length === 0, pops, lostEvents, ...(runtime === "mecanim" ? { held: held.slice(0, 12) } : {}), ...(traceOut ? { trace: traceOut } : {}) };
  });

  const lateFirstKeys: LateKey[] = [];
  for (const [name, anim] of Object.entries(animations)) {
    for (const tl of iterateTimelines(anim)) {
      if (!tl.keys.length || tl.kind.endsWith("events") || tl.kind.startsWith("drawOrder")) continue;
      const first = keyTime(tl.keys[0]!);
      if (first > 1e-6) lateFirstKeys.push({ animation: name, timeline: `${tl.kind} ${tl.owner}`.trim(), firstKey: +first.toFixed(4) });
    }
  }
  if (lateFirstKeys.length) {
    notes.push("lateFirstKeys matter on tracks above 0 and after Animation clean up: until the first key the property keeps the value under it, then jumps (Esoteric forum /d/24933). A key at 0 fixes it.");
  }
  const lost = results.filter((r) => r.lostEvents.length);
  if (lost.length) notes.push(`${lost.length} transition(s) lose events: the outgoing animation's events inside the mix are not fired with eventThreshold ${o.eventThreshold ?? 0}${o.eventThreshold === undefined ? " (the runtimes' default)" : ""}, so footsteps or sounds keyed there never play. Set the outgoing TrackEntry's eventThreshold (0.5 fires them through the first half of the mix), key them in the incoming animation too, or shorten the mix.`);
  if (runtime === "mecanim") notes.push("runtime mecanim: events are not checked (Unity fires them as AnimationEvents on the generated clips).");
  let mecanimMissingKeys: MixCheckResult["mecanimMissingKeys"];
  if (runtime === "mecanim") {
    const skeleton = { skeleton: {}, bones: [], animations } as unknown as SkeletonJson;
    const tested = [...new Set(transitions.map((t) => t.to))];
    mecanimMissingKeys = tested.map((n) => {
      const m = missingTimelines(skeleton, n, [...new Set(transitions.filter((t) => t.to === n).map((t) => t.from))]);
      return { animation: n, timelines: m.length, examples: m.slice(0, 8).map((x) => `${x.kind} ${x.owner}`.trim()) };
    }).filter((m) => m.timelines > 0);
    const mode = o.mecanimMode ?? "mixNext", reset = o.autoReset !== false;
    const effect = !reset
      ? "stay at the outgoing pose after the transition (autoReset off: nothing puts them back; see held)"
      : mode === "alwaysMix" ? "fade to the setup pose during the transition (AlwaysMix weighs the outgoing clip by 1 - w from the setup pose; properties both clips key sag toward setup mid-transition, by a quarter at the midpoint)"
      : `stay at the outgoing pose through the transition and snap to the setup pose when it ends${mode === "hard" ? " (Hard: the incoming clip also takes over its own keys at full weight on the first frame, no crossfade)" : ""}`;
    if (mecanimMissingKeys.length) notes.push(`SkeletonMecanim (${mode}, autoReset ${reset ? "on" : "off"}): timelines the outgoing animation keys and the incoming one does not ${effect}. spine_derive_animation with the setupKeys op adds them as keys at 0 (spine-unity documentation: Required Additional Keys).`);
    if (mode === "match") notes.push("Match resolves Unity's weights to lerp weights; with one clip per state (no blend trees) it plays like MixNext.");
    notes.push("runtime mecanim: transition durations are seconds (Animator transitions with Fixed Duration); one Animator layer, one clip per state (no blend trees, no interruptions).");
  }
  if (mixDefaultNote(o)) notes.push(mixDefaultNote(o)!);
  return { fps, track, base: o.base ?? null, tested: results.length, failing: results.filter((r) => !r.ok).length, transitions: results, lateFirstKeys, layeredPops, ...(mecanimMissingKeys ? { mecanimMissingKeys } : {}), runtime, notes };
}

/** SkeletonMecanim: what the outgoing animation keys on this bone or its parents and the incoming one does not. */
function mecanimCause(data: spine.SkeletonData, animations: Record<string, AnimationJson>, from: string, to: string, bone: string): string | undefined {
  const chain = new Set<string>();
  for (let b: spine.BoneData | null = data.findBone(bone); b; b = b.parent) chain.add(b.name);
  const own = new Set([...iterateTimelines(animations[to] ?? {})].map((t) => `${t.kind}|${t.owner}`));
  const lacking = [...iterateTimelines(animations[from] ?? {})].filter((t) => t.kind.startsWith("bone.") && chain.has(t.owner) && !own.has(`${t.kind}|${t.owner}`)).map((t) => `${t.kind.slice(5)} ${t.owner}`);
  if (!lacking.length) return undefined;
  return `${from} keys ${lacking.slice(0, 4).join(", ")}${lacking.length > 4 ? ", ..." : ""} and ${to} does not: SkeletonMecanim holds the ${from} pose through the transition and resets it to setup when it ends. Add setup keys to ${to} (spine_derive_animation op setupKeys).`;
}

/** IK bend direction is discrete: when the two animations disagree it flips at the end of the mix. */
function popCause(data: spine.SkeletonData, animations: Record<string, AnimationJson>, from: string, to: string, bone: string, phase: MixPop["phase"]): string | undefined {
  const bend = (anim: string, ik: spine.IkConstraintData, which: "last" | "first") => {
    const keys = animations[anim]?.ik?.[ik.name];
    const k = keys?.length ? keys[which === "last" ? keys.length - 1 : 0]! : undefined;
    return k ? ((k.bendPositive as boolean | undefined) ?? true) : ik.setupPose.bendDirection > 0;
  };
  // The bone itself or any ancestor driven by an IK constraint.
  const chain = new Set<string>();
  for (let b: spine.BoneData | null = data.findBone(bone); b; b = b.parent) chain.add(b.name);
  for (const c of data.constraints) {
    if (!(c instanceof spine.IkConstraintData) || !c.bones.some((b) => chain.has(b.name))) continue;
    const a = bend(from, c, "last"), b = bend(to, c, "first");
    if (a !== b) return `IK "${c.name}" bends ${a ? "positive" : "negative"} in ${from} and ${b ? "positive" : "negative"} in ${to}${animations[to]?.ik?.[c.name] ? "" : " (setup, not keyed)"}; the bend direction is discrete and switches ${phase === "mix end" ? "here, at the end of the mix" : "during the mix"}. Key the same bend direction in both, or key the IK mix to 0 across the switch.`;
  }
  // IK takeover: the IK mix differs a lot between the two animations, so the solver's share jumps to full strength by
  // the end of the mix. With a large FK/IK difference the result snaps (spineboy jump -> idle: easing the IK mix in over
  // twice the mix duration in the incoming animation removed it).
  const ikMix = (anim: string, ik: spine.IkConstraintData, which: "last" | "first") => {
    const keys = animations[anim]?.ik?.[ik.name];
    const k = keys?.length ? keys[which === "last" ? keys.length - 1 : 0]! : undefined;
    return k ? ((k.mix as number | undefined) ?? 1) : ik.setupPose.mix;
  };
  for (const c of data.constraints) {
    if (!(c instanceof spine.IkConstraintData) || !c.bones.some((b) => chain.has(b.name))) continue;
    const a = ikMix(from, c, "last"), b = ikMix(to, c, "first");
    if (Math.abs(a - b) >= 0.5) {
      return `IK "${c.name}" goes from mix ${+a.toFixed(2)} in ${from} to ${+b.toFixed(2)} in ${to}${animations[to]?.ik?.[c.name] ? "" : " (setup)"}, so the solver takes over within the ${phase === "mix end" ? "mix and lands here" : "mix"}; when the FK pose is far from the IK solution the result snaps. Ease the IK mix in ${to} over longer than the mix (e.g. key mix ${+a.toFixed(2)} at 0 and ${+b.toFixed(2)} about twice the mix duration later), or switch at a pose closer to the IK solution.`;
    }
  }
  if (phase === "mix end") return "At the end of the mix the outgoing animation stops applying: discrete values it keyed (IK bend direction, attachments, draw order) switch to the incoming animation's or setup values here.";
  return undefined;
}

function mixDefaultNote(o: MixCheckOptions): string | null {
  return o.defaultMix === undefined ? "Mix durations default to 0.2 s where the skeleton defines none (pass defaultMix or per-transition mix)." : null;
}
