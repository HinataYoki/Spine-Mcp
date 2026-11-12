// Face audit of existing animations: pose changes and mouth swaps the eyes are open for (instead of behind a blink),
// eye lines still drawn while the lids are shut, mouth bones left posed under another mouth drawing, blink timing.
import { poseChanges, suggest } from "./generate.js";
import { animationDuration } from "./inspect.js";
import { loadSkeletonData, spine } from "./runtime.js";
import type { AnimationJson, Key, SkeletonJson } from "./types.js";
import type { Issue, Severity } from "./validate.js";

export interface FaceAuditOptions {
  /** Animations to audit (default: all but `blink`). */
  animations?: string[];
  /** Eyelid bones: their motion gives the shut windows (default: bones named "lid" when no `eyes` are given). */
  lids?: string[];
  /** The shut lids as posed in an animation: "animation@seconds" (default: the farthest the lids move, in `blink` if given). */
  closedFrom?: string;
  /**
   * Eye slots that tell the eye state: shut while showing a `closed` attachment (default names with clos/blink/shut),
   * and while hidden if the slot shows the eye in the setup pose. A slot empty in the setup pose is a lid drawn over
   * the eye: hidden there means open.
   */
  eyes?: { slot: string; closed?: string[] }[];
  /** A blink animation played on a track above, looping at its own length (blinks kept apart from the idle). */
  blink?: string;
  /** Head and face bones whose fast moves are pose changes (default: the neck/head chain). */
  bones?: string[];
  rotateSpeed?: number;
  moveSpeed?: number;
  /** Slots that should be hidden while the lids are shut: lashes, lines drawn over the open eye (default: slots named "lash"). */
  hide?: string[];
  /** Mouth slots whose drawing swaps count as changes (default: slots named mouth/lips with 2+ attachments). */
  mouths?: string[];
  /** Bones that belong to one mouth drawing: they should be at their setup pose while another drawing is shown. */
  mouthGroups?: { slot: string; attachment: string; bones: string[] }[];
  /** Frame rate for frame counts and the hidden-change tolerance (default: skeleton fps, else 30). */
  fps?: number;
  /**
   * Several faces in one skeleton (two characters side by side): each audited on its own, with its own lids, eye slots,
   * hidden slots, head bones and mouths, so one face's blink never counts as the other's. The other options apply to all.
   */
  faces?: FaceOptions[];
}

export interface FaceOptions {
  name: string;
  lids?: string[];
  closedFrom?: string;
  eyes?: { slot: string; closed?: string[] }[];
  bones?: string[];
  hide?: string[];
  mouths?: string[];
  mouthGroups?: { slot: string; attachment: string; bones: string[] }[];
}

export interface BlinkTiming {
  /** Seconds: lids leave their rest, fully shut (99.8%), start to open, back at rest. */
  start: number;
  shut: [number, number];
  end: number;
  /** Frames at the skeleton fps: closing, held shut, opening. */
  frames: { close: number; closed: number; open: number };
  /** Frames of the frame grid on which the lids are shut (90%+; 0: played at that fps it may never show shut). */
  shutFrames: number;
  /** The animation starts or ends inside this blink: the frame counts cover only the part inside it. */
  cut?: boolean;
}

export interface FaceAnimationReport {
  animation: string;
  /** The face (with `faces`). */
  face?: string;
  duration: number;
  blinks: BlinkTiming[];
  /** Blinks that never fully shut: the most the lids close (1 = shut). */
  partialBlinks: { time: number; closure: number }[];
  poseChanges: { time: number; frame: number; bone: string; hidden: boolean }[];
  mouthSwaps: { time: number; frame: number; slot: string; from: string | null; to: string | null; hidden: boolean }[];
  visibleWhileShut: { slot: string; attachment: string; from: number; to: number }[];
  hiddenWhileOpen: { slot: string; from: number; to: number; closure: number }[];
  mouthGroups: { slot: string; attachment: string; bone: string; shown: string | null; from: number; to: number; offset: string; deformsShown: boolean }[];
}

export interface FaceAuditReport {
  fps: number;
  lids: string[];
  eyes: string[];
  closedPose: string;
  animations: FaceAnimationReport[];
  issues: Issue[];
  notes: string[];
}

const r3 = (n: number) => +n.toFixed(4);
const r1 = (n: number) => +n.toFixed(1);
const SHUT = 0.9, OPEN = 0.1, PARTIAL = 0.3;
const CLOSED = /(clos|blink|shut)/i;
// "Non-zero" as the invisible-keys check: under these nothing moves on screen.
const LIMIT = { rotate: 0.1, translate: 0.05, scale: 0.001 };

/** The attachment a slot shows at `t` from the animation's keys (the last key at or before t), else undefined. */
function keyedName(anim: AnimationJson | undefined, slot: string, t: number): string | null | undefined {
  const keys = anim?.slots?.[slot]?.attachment;
  if (!keys?.length) return undefined;
  let name: string | null | undefined;
  for (const k of keys) if ((k.time ?? 0) <= t + 1e-6) name = k.name ?? null;
  return name;
}

function keyTimes(anim: AnimationJson | undefined): number[] {
  const out: number[] = [];
  const walk = (m: unknown) => {
    if (Array.isArray(m)) { for (const k of m as Key[]) out.push(k.time ?? 0); return; }
    if (m && typeof m === "object") for (const v of Object.values(m)) walk(v);
  };
  if (anim) walk(anim);
  return out;
}

export function faceAudit(skeleton: SkeletonJson, o: FaceAuditOptions = {}): FaceAuditReport {
  if (o.faces?.length) return auditFaces(skeleton, o, o.faces);
  const data = loadSkeletonData(skeleton);
  const fps = o.fps ?? skeleton.skeleton.fps ?? 30;
  const anims = skeleton.animations ?? {};
  const sug = suggest(skeleton);
  const slotJson = new Map((skeleton.slots ?? []).map((s) => [s.name, s]));
  const need = (kind: "bone" | "slot", names: string[]) => {
    for (const n of names) if (kind === "bone" ? !data.findBone(n) : !data.findSlot(n)) throw new Error(`Unknown ${kind}: ${n}`);
  };
  const eyes = o.eyes ?? [];
  const lids = o.lids ?? (eyes.length ? [] : sug.lids);
  if (!lids.length && !eyes.length) throw new Error("face audit needs eyelid bones (lids) or eye slots (eyes) to find when the eyes are shut");
  need("bone", lids);
  need("slot", eyes.map((e) => e.slot));
  const bones = o.bones?.length ? o.bones : sug.look.bones;
  need("bone", bones);
  const hide = o.hide ?? (skeleton.slots ?? []).filter((s) => /lash/i.test(s.name)).map((s) => s.name);
  // Eye slots empty in the setup pose whose every drawing is a shut lid are a lid drawn over the eye: hidden is open.
  // An empty eye slot that also has an open eye drawing keeps hidden = shut.
  const isClosed = (e: { closed?: string[] }, n: string) => (e.closed ? e.closed.includes(n) : CLOSED.test(n));
  const drawings = (slot: string) => (skeleton.skins ?? []).flatMap((sk) => Object.keys(sk.attachments?.[slot] ?? {}));
  const lidOverlay = new Set(eyes.filter((e) => !slotJson.get(e.slot)?.attachment && drawings(e.slot).length > 0
    && drawings(e.slot).every((n) => isClosed(e, n))).map((e) => e.slot));
  need("slot", hide);
  const mouths = o.mouths ?? sug.mouths.map((m) => m.slot);
  need("slot", mouths);
  for (const g of o.mouthGroups ?? []) { need("slot", [g.slot]); need("bone", g.bones); }
  const overlay = o.blink ? data.findAnimation(o.blink) : null;
  if (o.blink && !overlay) throw new Error(`Animation "${o.blink}" not found`);
  const names = o.animations?.length ? o.animations : Object.keys(anims).filter((n) => n !== o.blink);
  for (const n of names) if (!data.findAnimation(n)) throw new Error(`Animation "${n}" not found`);

  const sk = new spine.Skeleton(data);
  const issues: Issue[] = [];
  const add = (severity: Severity, code: string, message: string, where?: string) => issues.push({ severity, code, message, where });
  const notes: string[] = [];

  // Lid shape: three points of each lid (origin, along x, along y) in the space of the first parent that is not an
  // eyelid bone, so head turns and eye darts do not read as lid motion. Translate, rotate and scale all move them.
  const lidSet = new Set(lids);
  const refOf = (b: spine.Bone) => { let p = b.parent; while (p && (lidSet.has(p.data.name) || /lid/i.test(p.data.name))) p = p.parent; return p; };
  const lidBones = lids.map((n) => sk.findBone(n)!);
  const refs = lidBones.map(refOf);
  const len = lidBones.map((b) => b.data.length || Math.max(1, (skeleton.skeleton.height ?? 300) * 0.02));
  const lidPoints = () => {
    const out: number[] = [];
    lidBones.forEach((b, i) => {
      const p = b.appliedPose, ref = refs[i]?.appliedPose, L = len[i]!;
      for (const [lx, ly] of [[0, 0], [L, 0], [0, L]] as const) {
        let x = p.a * lx + p.b * ly + p.worldX, y = p.c * lx + p.d * ly + p.worldY;
        if (ref) {
          const det = ref.a * ref.d - ref.b * ref.c || 1, dx = x - ref.worldX, dy = y - ref.worldY;
          x = (ref.d * dx - ref.b * dy) / det; y = (-ref.c * dx + ref.a * dy) / det;
        }
        out.push(x, y);
      }
    });
    return out;
  };
  const pose = (anim: spine.Animation | null, t: number, withOverlay: boolean) => {
    sk.setupPose();
    anim?.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
    if (withOverlay && overlay) overlay.apply(sk, t, t, true, null, 1, spine.MixFrom.setup, false, false, false);
    sk.updateWorldTransform(spine.Physics.none);
  };
  pose(null, 0, false);
  const rest = lidPoints();
  const disp = () => lidPoints().map((v, i) => v - rest[i]!);

  // The shut reference: a given pose, else the farthest the lids move in the audited animations (and the blink).
  let shutRef: number[] | null = null, closedPose = "none (eye slots only)";
  if (lids.length && o.closedFrom) {
    const m = /^(.+)@([\d.]+)$/.exec(o.closedFrom);
    if (!m) throw new Error(`closedFrom must be "animation@seconds": ${o.closedFrom}`);
    const a = data.findAnimation(m[1]!);
    if (!a) throw new Error(`Animation "${m[1]}" not found`);
    pose(a, Number(m[2]), false);
    shutRef = disp();
    closedPose = o.closedFrom;
  } else if (lids.length) {
    let best = 0;
    for (const n of o.blink ? [o.blink] : names) {
      const a = data.findAnimation(n)!, steps = Math.max(1, Math.ceil(a.duration * 240));
      for (const t of [...Array.from({ length: steps + 1 }, (_, k) => (a.duration * k) / steps), ...keyTimes(anims[n]).filter((t) => t <= a.duration)]) {
        pose(a, t, false);
        const d = disp(), m = Math.hypot(...d);
        if (m > best) { best = m; shutRef = d; closedPose = `${n}@${r3(t)}`; }
      }
    }
    if (best < 0.05) { shutRef = null; closedPose = "none: the lids never move"; }
  }
  const refLen2 = shutRef ? shutRef.reduce((s, v) => s + v * v, 0) : 0;
  /** How shut the eyes are in the current pose: the lids' share of the way to the shut pose, 1 when an eye slot is closed. */
  const closureNow = (json: AnimationJson, t: number, ov: boolean) => {
    let c = 0;
    if (shutRef) { const d = disp(); c = d.reduce((s, v, i) => s + v * shutRef![i]!, 0) / refLen2; }
    for (const e of eyes) {
      const n = visible(e.slot, json, t, ov);
      if (n === null ? !lidOverlay.has(e.slot) : isClosed(e, n)) c = Math.max(c, 1);
    }
    return c;
  };
  if (lids.length && shutRef && refLen2 < 1e-6) throw new Error(`The lids are at their setup pose in ${closedPose}: nothing to measure closing against`);

  const shownName = (slot: string, anim: AnimationJson | undefined, t: number, ov: boolean) => {
    let n: string | null | undefined;
    if (ov) n = keyedName(anims[o.blink!], slot, overlay!.duration > 0 ? t % overlay!.duration : t);
    if (n === undefined) n = keyedName(anim, slot, t);
    return n === undefined ? (slotJson.get(slot)?.attachment ?? null) : n;
  };
  const visible = (slot: string, anim: AnimationJson | undefined, t: number, ov: boolean) => {
    const n = shownName(slot, anim, t, ov);
    return n !== null && sk.findSlot(slot)!.pose.color.a > 0.01 ? n : null;
  };
  const meshBones = (slot: string, att: string): Set<string> => {
    for (const skin of skeleton.skins ?? []) {
      const a = skin.attachments?.[slot]?.[att];
      if (!a) continue;
      const out = new Set<string>();
      const v = a.vertices ?? [], weighted = a.uvs && v.length > a.uvs.length;
      if (weighted) for (let i = 0; i < v.length;) { const c = v[i++]!; for (let j = 0; j < c; j++, i += 4) out.add(skeleton.bones[v[i]!]?.name ?? ""); }
      return out;
    }
    return new Set();
  };
  const descends = (bone: spine.BoneData, of: string) => { for (let b: spine.BoneData | null = bone; b; b = b.parent) if (b.name === of) return true; return false; };

  const reports: FaceAnimationReport[] = [], ownBlinks: string[] = [];
  for (const name of names) {
    const a = data.findAnimation(name)!, json = anims[name]!;
    // An animation whose own lid or eye keys shut the eyes blinks itself: the blink track would replace those blinks.
    // Keys that only hold a pose (setup keys added for SkeletonMecanim, say) leave the track on.
    const keysEyes = lids.some((l) => json.bones?.[l]) || eyes.some((e) => json.slots?.[e.slot]);
    const own = keysEyes && Array.from({ length: Math.max(1, Math.ceil(a.duration * 240)) + 1 }, (_, k) => (a.duration * k) / Math.max(1, Math.ceil(a.duration * 240)))
      .concat(keyTimes(json).filter((t) => t <= a.duration + 1e-6))
      .some((t) => { pose(a, t, false); return closureNow(json, t, false) >= SHUT; });
    const ov = !!overlay && !own;
    if (overlay && own) ownBlinks.push(name);
    const duration = r3(animationDuration(json));
    // Samples: a fine grid, the frame grid and every key (so sub-frame holds are seen).
    // Exact times, deduplicated to a microsecond (rounded only in the report).
    const ts = new Map<number, number>(), addT = (t: number) => { if (!ts.has(Math.round(t * 1e6))) ts.set(Math.round(t * 1e6), t); };
    const fine = Math.max(1, Math.ceil(a.duration * 240));
    for (let k = 0; k <= fine; k++) addT((a.duration * k) / fine);
    for (let k = 0; k <= Math.floor(a.duration * fps + 1e-6); k++) addT(k / fps);
    for (const t of keyTimes(json)) if (t <= a.duration + 1e-6) addT(t);
    if (ov && overlay!.duration > 0) for (const t0 of keyTimes(anims[o.blink!])) for (let t = t0; t <= a.duration + 1e-6; t += overlay!.duration) addT(t);
    const times = [...ts.values()].sort((x, y) => x - y);
    // Blink timing snaps to the lid and eye keys nearby (a quarter frame): eased curves only approach the shut pose.
    const eyeKeys: number[] = [];
    const eyeTimelines = (j: AnimationJson | undefined) => [...lids.map((l) => j?.bones?.[l]), ...eyes.map((e) => j?.slots?.[e.slot])];
    for (const tl of eyeTimelines(json)) eyeKeys.push(...keyTimes(tl as AnimationJson));
    if (ov && overlay!.duration > 0) for (const tl of eyeTimelines(anims[o.blink!])) for (const t0 of keyTimes(tl as AnimationJson)) for (let t = t0; t <= a.duration + 1e-6; t += overlay!.duration) eyeKeys.push(t);
    const snap = (t: number) => { let best = t, d = 0.25 / fps; for (const k of eyeKeys) if (Math.abs(k - t) <= d) { d = Math.abs(k - t); best = k; } return best; };
    const closure: number[] = [], shown: Map<string, (string | null)[]> = new Map(), groupOff: Map<string, string[]> = new Map();
    for (const s of new Set([...hide, ...mouths, ...(o.mouthGroups ?? []).map((g) => g.slot)])) shown.set(s, []);
    for (const t of times) {
      pose(a, t, ov);
      closure.push(closureNow(json, t, ov));
      for (const [s, list] of shown) list.push(visible(s, json, t, ov));
      for (const g of o.mouthGroups ?? []) for (const b of g.bones) {
        const bone = sk.findBone(b)!, p = bone.pose, s = bone.data.setupPose;
        const parts: string[] = [];
        if (Math.abs(p.rotation - s.rotation) >= LIMIT.rotate) parts.push(`rotate ${r1(p.rotation - s.rotation)}`);
        if (Math.hypot(p.x - s.x, p.y - s.y) >= LIMIT.translate) parts.push(`translate ${r3(p.x - s.x)}, ${r3(p.y - s.y)}`);
        if (Math.abs(p.scaleX / (s.scaleX || 1) - 1) >= LIMIT.scale || Math.abs(p.scaleY / (s.scaleY || 1) - 1) >= LIMIT.scale) parts.push(`scale ${r3(p.scaleX / (s.scaleX || 1))}, ${r3(p.scaleY / (s.scaleY || 1))}`);
        if (Math.abs(p.shearX - s.shearX) >= LIMIT.rotate || Math.abs(p.shearY - s.shearY) >= LIMIT.rotate) parts.push("shear");
        const key = `${g.slot}|${g.attachment}|${b}`;
        if (!groupOff.has(key)) groupOff.set(key, []);
        groupOff.get(key)!.push(parts.join(", "));
      }
    }

    // Blinks: each stretch at or above SHUT is one (the eyes read as closed; changes hide there), even when the lids
    // stay half lowered between two of them. Timing runs from where the lids leave their rest (closure stops falling)
    // to fully shut (99.8% of the blink's peak) and back. Runs above OPEN that never shut are partial blinks.
    const blinks: BlinkTiming[] = [], dark: [number, number][] = [], partial: FaceAnimationReport["partialBlinks"] = [];
    for (let i = 0; i < times.length;) {
      if (closure[i]! <= OPEN) { i++; continue; }
      let j = i;
      while (j + 1 < times.length && closure[j + 1]! > OPEN) j++;
      const run = Array.from({ length: j - i + 1 }, (_, k) => i + k);
      const peak = Math.max(...run.map((k) => closure[k]!));
      if (peak < SHUT && peak >= PARTIAL) partial.push({ time: r3(times[run.find((k) => closure[k] === peak)!]!), closure: r3(peak) });
      for (let p = i; p <= j;) {
        if (closure[p]! < SHUT) { p++; continue; }
        let q = p;
        while (q + 1 <= j && closure[q + 1]! >= SHUT) q++;
        let a = p, b = q;
        while (a > 0 && closure[a - 1]! < closure[a]! - 1e-6) a--;
        while (b + 1 < times.length && closure[b + 1]! < closure[b]! - 1e-6) b++;
        const seg = Array.from({ length: q - p + 1 }, (_, k) => p + k), top = Math.max(...seg.map((k) => closure[k]!));
        const full = seg.filter((k) => closure[k]! >= Math.max(SHUT, Math.min(top, 1) * 0.998));
        const s0 = snap(times[full[0]!]!), s1 = snap(times[full[full.length - 1]!]!), start = snap(times[a]!), end = snap(times[b]!);
        const d0 = times[p]!, d1 = times[q]!;
        let onGrid = 0;
        for (let k = Math.ceil(d0 * fps - 1e-6); k / fps <= d1 + 1e-6; k++) onGrid++;
        blinks.push({ start: r3(start), shut: [r3(s0), r3(s1)], end: r3(end), frames: { close: r1((s0 - start) * fps), closed: r1((s1 - s0) * fps), open: r1((end - s1) * fps) }, shutFrames: onGrid, ...(a === 0 && closure[0]! > OPEN || b + 1 === times.length && closure[b]! > OPEN ? { cut: true } : {}) });
        dark.push([d0, d1]);
        p = q + 1;
      }
      i = j + 1;
    }
    const tol = 1 / fps + 1e-6;
    const hiddenAt = (t: number) => dark.some(([a, b]) => t >= a - tol && t <= b + tol);

    // A move already under way at 0 s continues from the loop end (or the previous animation): nothing to hide there.
    const changes = poseChanges(skeleton, name, bones, { rotateSpeed: o.rotateSpeed, moveSpeed: o.moveSpeed, fps }).filter((c) => c.time > 0).map((c) => ({ ...c, frame: r1(c.time * fps), hidden: hiddenAt(c.time) }));
    const swaps: FaceAnimationReport["mouthSwaps"] = [];
    for (const m of mouths) {
      const list = shown.get(m)!;
      for (let k = 1; k < times.length; k++) if (list[k] !== list[k - 1]) swaps.push({ time: r3(times[k]!), frame: r1(times[k]! * fps), slot: m, from: list[k - 1]!, to: list[k]!, hidden: hiddenAt(times[k]!) });
    }
    swaps.sort((x, y) => x.time - y.time);

    const visibleWhileShut: FaceAnimationReport["visibleWhileShut"] = [];
    for (const [d0, d1] of dark) for (const s of hide) {
      const list = shown.get(s)!;
      const at = times.map((t, k) => [t, list[k]] as const).filter(([t, n]) => t >= d0 - 1e-6 && t <= d1 + 1e-6 && n !== null);
      // Only what a frame shows: drawn on a frame of the frame grid, or for a quarter frame or more.
      const onFrame = at.some(([t]) => Math.abs(t * fps - Math.round(t * fps)) < 1e-6);
      if (at.length && (onFrame || (at[at.length - 1]![0] - at[0]![0]) * fps >= 0.25)) visibleWhileShut.push({ slot: s, attachment: at[0]![1]!, from: r3(at[0]![0]), to: r3(at[at.length - 1]![0]) });
    }

    const hiddenWhileOpen: FaceAnimationReport["hiddenWhileOpen"] = [];
    for (const s of hide) {
      const list = shown.get(s)!;
      if (!list.some((n) => n !== null) || !list.some((n) => n === null)) continue;
      for (const b of blinks) {
        const w0 = b.start - 2 / fps, w1 = b.end + 2 / fps;
        const at = times.map((t, k) => [t, k] as const).filter(([t, k]) => t >= w0 - 1e-6 && t <= w1 + 1e-6 && list[k] === null && closure[k]! <= OPEN);
        if (!at.length) continue;
        let i0 = 0;
        for (let i = 1; i <= at.length; i++) {
          if (i < at.length && at[i]![1] === at[i - 1]![1] + 1) continue;
          const run = at.slice(i0, i), t0 = run[0]![0], t1 = run[run.length - 1]![0];
          const onFrame = run.some(([t]) => Math.abs(t * fps - Math.round(t * fps)) < 1e-6);
          if (onFrame || (t1 - t0) * fps >= 0.25) hiddenWhileOpen.push({ slot: s, from: r3(t0), to: r3(t1), closure: r3(Math.min(...run.map(([, k]) => closure[k]!))) });
          i0 = i;
        }
      }
    }

    const groups: FaceAnimationReport["mouthGroups"] = [];
    for (const g of o.mouthGroups ?? []) for (const b of g.bones) {
      const off = groupOff.get(`${g.slot}|${g.attachment}|${b}`)!, list = shown.get(g.slot)!;
      for (let k = 0; k < times.length;) {
        if (!off[k] || list[k] === g.attachment) { k++; continue; }
        let j = k;
        while (j + 1 < times.length && off[j + 1] && list[j + 1] === list[k]) j++;
        const shownName = list[k]!;
        const deforms = !!shownName && (meshBones(g.slot, shownName).has(b) || descends(data.findSlot(g.slot)!.boneData, b));
        groups.push({ slot: g.slot, attachment: g.attachment, bone: b, shown: shownName, from: r3(times[k]!), to: r3(times[j]!), offset: off[k]!, deformsShown: deforms });
        k = j + 1;
      }
    }

    const where = `animations/${name}`;
    const open = changes.filter((c) => !c.hidden), openSwaps = swaps.filter((s) => !s.hidden);
    if (open.length) add("warning", "face-open-pose-change", `"${name}" changes pose with the eyes open at ${open.slice(0, 8).map((c) => `${c.time}s (frame ${c.frame}, ${c.bone})`).join(", ")}${open.length > 8 ? ", ..." : ""}${blinks.length ? "" : " (no blink in it)"}: put a blink over each change (lids shut as the move starts) so it reads as a cut, not a slide. blink onPoses does this.`, where);
    if (openSwaps.length) add("warning", "face-open-mouth-swap", `"${name}" swaps the mouth drawing with the eyes open at ${openSwaps.slice(0, 8).map((s) => `${s.time}s (${s.slot}: ${s.from ?? "none"} -> ${s.to ?? "none"})`).join(", ")}${openSwaps.length > 8 ? ", ..." : ""}. Fine for speech; for an expression change, hide it behind a blink.`, where);
    for (const v of visibleWhileShut) add("warning", "face-visible-while-shut", `"${name}" still draws ${v.slot} (${v.attachment}) while the lids are shut (${v.from}s to ${v.to}s): hide it with an attachment key as the lids close (blink hide does this).`, where);
    for (const h of hiddenWhileOpen) add("warning", "face-hidden-while-open", `"${name}" hides ${h.slot} on an open eye from ${h.from}s to ${h.to}s (frame ${r1(h.from * fps)} to ${r1(h.to * fps)}; lids down only ${Math.round(h.closure * 100)}%): its on/off keys miss the lids. Key the switch on whole frames by a threshold (e.g. 15% shut): off on the first frame the lids are at or past it, back on the last frame they still are (blink hideAt does this).`, where);
    for (const g of groups) add("warning", "face-mouth-group-posed", `"${name}" keeps ${g.bone} (${g.attachment}'s bone) posed (${g.offset}) from ${g.from}s to ${g.to}s while ${g.slot} shows ${g.shown ?? "nothing"}: ${g.deformsShown ? `it moves the drawing on screen, ${g.shown}` : `${g.attachment} comes back already posed`}. Key it back to setup at the swap.`, where);
    for (const [k, b] of blinks.entries()) if (!b.shutFrames && !b.cut) add("warning", "face-blink-subframe", `"${name}" is shut only from ${r3(dark[k]![0])}s to ${r3(dark[k]![1])}s, between frames at ${fps} fps: played at that rate the blink may never show the eyes closed. Hold the shut pose on at least one frame.`, where);
    for (const p of partial) add("info", "face-partial-blink", `"${name}" closes the lids to ${Math.round(p.closure * 100)}% of the shut pose at ${p.time}s and opens again: a squint, or a blink that never shuts.`, where);
    reports.push({ animation: name, duration, blinks, partialBlinks: partial, poseChanges: changes, mouthSwaps: swaps, visibleWhileShut, hiddenWhileOpen, mouthGroups: groups });
  }

  notes.push(`Shut means the lids are at least ${SHUT * 100}% of the way to the shut pose (${closedPose}${o.closedFrom || !lids.length ? "" : `, the farthest the lids move${o.blink ? ` in ${o.blink}` : ""}; pass closedFrom if they never fully shut there`}), measured on the lid bones relative to the eye${eyes.length ? `, or the eye slots (${eyes.map((e) => e.slot).join(", ")}) showing a closed drawing${eyes.some((e) => !lidOverlay.has(e.slot)) ? " or hidden" : ""}${lidOverlay.size ? ` (${[...lidOverlay].join(", ")}: empty at setup, a lid over the eye, so hidden is open)` : ""}` : ""}; open is under ${OPEN * 100}%. A change is behind a blink when it starts within a frame of a shut window. Frames at ${fps} fps${o.fps || skeleton.skeleton.fps ? "" : " (the skeleton has no fps; 30 assumed)"}.`);
  if (o.blink) notes.push(`${o.blink} plays on a track above each animation, looping every ${r3(overlay!.duration)}s from 0 (its phase against the animation is arbitrary: the game starts it)${ownBlinks.length ? `; not over ${ownBlinks.join(", ")}, which shut the eyes with their own keys and blink on their own` : ""}.`);
  if (!blinksFound(reports)) notes.push(o.blink ? "No blink found in any audited animation, even with the blink track." : "No blink found in the audited animations: if blinks play on their own track, pass it as blink.");
  const split = faceSplit(skeleton, bones, lids, eyes, hide, mouths);
  if (split) notes.push(`The lids, eye slots and hidden slots sit under different heads (${split.map((s) => s.name).join(", ")}): audited together, one face's blink counts as the other's (its lashes read as drawn while shut). Pass faces to audit each on its own, e.g. faces: ${JSON.stringify(split)}.`);
  notes.push(`Pose changes (moves already under way at 0s not counted): ${bones.join(", ")} faster than ${o.rotateSpeed ?? 20} deg/s or ${r3(o.moveSpeed ?? Math.max(1, (skeleton.skeleton.height ?? 300) * 0.08))} units/s. Checked while shut: ${hide.join(", ") || "none (pass hide)"}; mouths: ${mouths.join(", ") || "none"}${o.mouthGroups?.length ? "" : "; no mouthGroups"}.`);
  return { fps, lids, eyes: eyes.map((e) => e.slot), closedPose, animations: reports, issues, notes };
}

const blinksFound = (r: FaceAnimationReport[]) => r.some((a) => a.blinks.length);

/** Each face on its own, then one report: animations tagged with their face, issues and notes prefixed with it. */
function auditFaces(skeleton: SkeletonJson, o: FaceAuditOptions, faces: FaceOptions[]): FaceAuditReport {
  // A face without its own pose bones takes the candidates (bones given, or the neck/head ones by name) above its lids
  // and eye slots: another face's head turning is not this face's pose change.
  const candidates = o.bones?.length ? o.bones : suggest(skeleton).look.bones;
  const parent = new Map(skeleton.bones.map((b) => [b.name, b.parent ?? null]));
  const slotBone = new Map((skeleton.slots ?? []).map((s) => [s.name, s.bone]));
  const above = (f: FaceOptions) => {
    const own = new Set<string>();
    for (const start of [...(f.lids ?? []), ...(f.eyes ?? []).map((e) => slotBone.get(e.slot))]) for (let b: string | null = start ?? null; b; b = parent.get(b) ?? null) own.add(b);
    return candidates.filter((b) => own.has(b));
  };
  const parts = faces.map((f) => {
    // Nothing falls back to name-based suggestions across faces: each face lists what is its own.
    try {
      return { f, r: faceAudit(skeleton, { ...o, faces: undefined, lids: f.lids ?? [], eyes: f.eyes ?? [], closedFrom: f.closedFrom ?? o.closedFrom, bones: f.bones ?? above(f), hide: f.hide ?? [], mouths: f.mouths ?? [], mouthGroups: f.mouthGroups }) };
    } catch (e) {
      throw new Error(`face "${f.name}": ${(e as Error).message}`);
    }
  });
  return {
    fps: parts[0]!.r.fps,
    lids: parts.flatMap((p) => p.r.lids),
    eyes: parts.flatMap((p) => p.r.eyes),
    closedPose: parts.map((p) => `${p.f.name}: ${p.r.closedPose}`).join("; "),
    animations: parts.flatMap((p) => p.r.animations.map((a) => ({ ...a, face: p.f.name }))),
    issues: parts.flatMap((p) => p.r.issues.map((i) => ({ ...i, message: `${p.f.name}: ${i.message}` }))),
    notes: parts.flatMap((p) => p.r.notes.map((n) => `${p.f.name}: ${n}`)),
  };
}

/** Faces by head: the head bone (one of `bones`) above each lid and eye slot, hidden slots and mouths following; null for one face. */
function faceSplit(skeleton: SkeletonJson, heads: string[], lids: string[], eyes: { slot: string; closed?: string[] }[], hide: string[], mouths: string[]): FaceOptions[] | null {
  const parent = new Map(skeleton.bones.map((b) => [b.name, b.parent ?? null]));
  const slotBone = new Map((skeleton.slots ?? []).map((s) => [s.name, s.bone]));
  const headSet = new Set(heads);
  // The topmost pose bone above a part: eye bones under the head (pose bones too, for gaze) are one face, not two.
  const headOf = (bone: string | undefined) => { let top: string | null = null; for (let b: string | null = bone ?? null; b; b = parent.get(b) ?? null) if (headSet.has(b)) top = b; return top; };
  const faces = new Map<string, { name: string; bones: string[]; lids: string[]; eyes: { slot: string; closed?: string[] }[]; hide: string[]; mouths: string[] }>();
  const face = (h: string | null) => {
    if (!h) return null;
    if (!faces.has(h)) faces.set(h, { name: h, bones: [h], lids: [], eyes: [], hide: [], mouths: [] });
    return faces.get(h)!;
  };
  for (const l of lids) face(headOf(l))?.lids.push(l);
  for (const e of eyes) face(headOf(slotBone.get(e.slot)))?.eyes.push(e);
  // Only heads with lids or eyes are faces: a neck above a head is not one.
  const withEyes = [...faces.values()].filter((f) => f.lids.length || f.eyes.length);
  if (withEyes.length < 2) return null;
  const owner = (bone: string | undefined) => { for (let b: string | null = bone ?? null; b; b = parent.get(b) ?? null) { const f = withEyes.find((x) => x.name === b); if (f) return f; } return null; };
  for (const s of hide) owner(slotBone.get(s))?.hide.push(s);
  for (const m of mouths) owner(slotBone.get(m))?.mouths.push(m);
  return withEyes.map((f) => ({ name: f.name, bones: f.bones, ...(f.lids.length ? { lids: f.lids } : {}), ...(f.eyes.length ? { eyes: f.eyes } : {}), ...(f.hide.length ? { hide: f.hide } : {}), ...(f.mouths.length ? { mouths: f.mouths } : {}) }));
}
