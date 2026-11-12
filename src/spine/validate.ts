import { iterateTimelines } from "./inspect.js";
import { measureMotion } from "./measure.js";
import { foldIssues } from "./folds.js";
import { jointIssues, type ImageLookup } from "./gaps.js";
import { weightOrderConflicts } from "./intake.js";
import { keyHygiene } from "./keyhygiene.js";
import { loadSkeletonData, spine } from "./runtime.js";
import { sampleAnimation } from "./sample.js";
import type { AttachmentJson, Key, SkeletonJson } from "./types.js";

export type Severity = "error" | "warning" | "info";

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  /** JSON-ish location, e.g. "animations/idle/bones/head/rotate[3]". */
  where?: string;
}

export interface ValidateOptions {
  /** Run spine-core load + per-animation sampling (NaN, seam, pops). Default true. */
  runtime?: boolean;
  /** Animations that must loop cleanly. Default: names with idle/walk/run/loop/cycle, minus transitions (turn, -to-, start…). */
  loopAnimations?: string[];
  fps?: number;
  /** Only sample these animations at runtime, and do so even when unrelated static errors exist. */
  runtimeAnimations?: string[];
  /** The project's images, for joint checks on the drawn pixels (without them, whole attachment shapes count as drawn). */
  images?: ImageLookup;
}

const LOOP_NAME = /idle|walk|run|loop|cycle/i;
// Transitions and one-shots that often share loop words ("idle-turn", "run-to-idle").
const NOT_LOOP_NAME = /(^|[-_ ])(turn|to|from|start|stop|end|enter|exit|transition|intro|outro)([-_ ]|$)/i;
const CONSTRAINT_TYPES = ["ik", "transform", "path", "physics", "slider"] as const;
// Number of curve values per key for timelines with more than one channel; others use 1 channel (4 numbers).
const CHANNELS: Record<string, number> = {
  "bone.translate": 2, "bone.scale": 2, "bone.shear": 2,
  "slot.rgba": 4, "slot.rgb": 3, "slot.rgba2": 7, "slot.rgb2": 6,
  ik: 2, transform: 6, "path.mix": 3,
};

export function validateSkeleton(doc: SkeletonJson, opts: ValidateOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Severity, code: string, message: string, where?: string) => issues.push({ severity, code, message, where });

  const dupes = (kind: string, names: string[]) => {
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) add("error", "duplicate-name", `Duplicate ${kind} name "${n}"`, kind);
      seen.add(n);
    }
  };
  const boneIndex = new Map(doc.bones.map((b, i) => [b.name, i]));
  // Keys that change the value so little nothing moves on screen: dead keys (often left over from a nudge).
  for (const [anim, a] of Object.entries(doc.animations ?? {})) {
    const tiny: string[] = [];
    for (const [bone, tls] of Object.entries(a.bones ?? {})) {
      for (const [prop, keys] of Object.entries(tls)) {
        if (keys.length < 2) continue;
        const fields = prop.startsWith("scale") ? ["value", "x", "y"] : ["value", "x", "y"];
        const limit = prop === "rotate" || prop.startsWith("shear") ? 0.1 : prop.startsWith("scale") ? 0.001 : prop.startsWith("translate") ? 0.05 : null;
        if (limit === null) continue;
        const neutral = prop.startsWith("scale") ? 1 : 0;
        let moving = false, max = 0;
        for (const f of fields) {
          const vals = keys.map((k) => (k[f] as number | undefined)).filter((v): v is number => typeof v === "number");
          if (!vals.length) continue;
          const all = keys.map((k) => (k[f] as number | undefined) ?? neutral);
          const range = Math.max(...all) - Math.min(...all);
          max = Math.max(max, range);
          if (range >= limit) moving = true;
        }
        if (!moving && max > 0) tiny.push(`${bone} ${prop} (${+max.toFixed(4)})`);
      }
    }
    if (tiny.length) add("info", "invisible-keys", `"${anim}" keys ${tiny.length} timeline(s) whose values change too little to see (under 0.1 degrees, 0.05 units or 0.1% scale): ${tiny.slice(0, 8).join(", ")}${tiny.length > 8 ? ", ..." : ""}. Dead keys cost runtime work; delete them or give them a visible change.`, `animations/${anim}`);
  }
  const slots = new Map((doc.slots ?? []).map((s) => [s.name, s]));
  // Constraint names are unique per type in 4.3 (a physics and a transform constraint may share a name).
  const constraints = new Map((doc.constraints ?? []).map((c) => [`${c.type}:${c.name}`, c]));
  const constraintNames = new Set((doc.constraints ?? []).map((c) => c.name));
  const animations = doc.animations ?? {};
  dupes("bone", doc.bones.map((b) => b.name));
  dupes("slot", [...(doc.slots ?? []).map((s) => s.name)]);
  for (const type of new Set((doc.constraints ?? []).map((c) => c.type))) {
    dupes(`${type} constraint`, (doc.constraints ?? []).filter((c) => c.type === type).map((c) => c.name));
  }

  // Bones: parents must come first (Spine's update order).
  doc.bones.forEach((b, i) => {
    if (!b.parent) {
      if (i !== 0) add("warning", "extra-root", `Bone "${b.name}" has no parent but is not the first bone`, `bones[${i}]`);
      return;
    }
    const pi = boneIndex.get(b.parent);
    if (pi === undefined) add("error", "missing-bone", `Parent "${b.parent}" of bone "${b.name}" does not exist`, `bones[${i}]`);
    else if (pi >= i) add("error", "bone-order", `Parent "${b.parent}" must be listed before "${b.name}"`, `bones[${i}]`);
  });

  // Attachments per slot across all skins.
  const attachmentsBySlot = new Map<string, Map<string, AttachmentJson>>();
  const linked: { skin: string; slot: string; name: string; a: AttachmentJson }[] = [];
  for (const skin of doc.skins ?? []) {
    for (const [slot, atts] of Object.entries(skin.attachments ?? {})) {
      if (!slots.has(slot)) add("error", "missing-slot", `Skin "${skin.name}" has attachments for unknown slot "${slot}"`, `skins/${skin.name}`);
      const m = attachmentsBySlot.get(slot) ?? new Map<string, AttachmentJson>();
      for (const [name, a] of Object.entries(atts)) {
        m.set(name, a);
        checkAttachment(skin.name, slot, name, a);
      }
      attachmentsBySlot.set(slot, m);
    }
    for (const b of skin.bones ?? []) if (!boneIndex.has(b)) add("error", "missing-bone", `Skin "${skin.name}" lists unknown bone "${b}"`, `skins/${skin.name}`);
    for (const c of skin.constraints ?? []) if (!constraintNames.has(c)) add("error", "missing-constraint", `Skin "${skin.name}" lists unknown constraint "${c}"`, `skins/${skin.name}`);
    // 4.3 lists skin constraints per type.
    for (const type of CONSTRAINT_TYPES) {
      for (const c of (skin[type] as string[] | undefined) ?? []) {
        if (!constraints.has(`${type}:${c}`)) add("error", "missing-constraint", `Skin "${skin.name}" lists unknown ${type} constraint "${c}"`, `skins/${skin.name}`);
      }
    }
  }
  // Linked meshes (4.3: `source` mesh in `skin` (default skin if omitted), slot `slot` or the attachment's own slot).
  const skinByName = new Map((doc.skins ?? []).map((k) => [k.name, k]));
  for (const l of linked) {
    const skin = skinByName.get((l.a.skin as string | undefined) ?? "default");
    const slot = (l.a.slot as string | undefined) ?? l.slot;
    const source = skin?.attachments?.[slot]?.[l.a.source as string];
    const where = `skins/${l.skin}/${l.slot}/${l.name}`;
    if (!skin) add("error", "missing-skin", `Linked mesh "${l.name}" source skin "${l.a.skin ?? "default"}" not found`, where);
    else if (!source) add("error", "missing-attachment", `Linked mesh "${l.name}" source "${l.a.source}" not found in skin "${skin.name}" slot "${slot}"`, where);
    else if ((source.type ?? "region") !== "mesh") add("error", "linked-mesh-source", `Linked mesh "${l.name}" source "${l.a.source}" is a ${source.type ?? "region"}, not a mesh`, where);
  }

  function checkAttachment(skin: string, slot: string, name: string, a: AttachmentJson) {
    const where = `skins/${skin}/${slot}/${name}`;
    const type = a.type ?? "region";
    if (type === "linkedmesh") {
      if (!a.source) add("error", "linked-mesh-source", `Linked mesh "${name}" has no source`, where);
      else linked.push({ skin, slot, name, a });
      if (a.slot !== undefined && !slots.has(a.slot as string)) add("error", "missing-slot", `Linked mesh source slot "${a.slot}" not found`, where);
    }
    if (type === "mesh" && a.uvs && a.vertices) {
      const vertexCount = a.uvs.length / 2;
      for (const t of a.triangles ?? []) {
        if (t >= vertexCount) { add("error", "mesh-index", `Triangle index ${t} >= vertex count ${vertexCount}`, where); break; }
      }
      if (a.vertices.length !== a.uvs.length) {
        // Weighted: [boneCount, (boneIndex, x, y, weight) * boneCount] per vertex (GOTCHAS G13).
        let i = 0, v = 0;
        while (i < a.vertices.length) {
          const n = a.vertices[i++]!;
          for (let k = 0; k < n; k++, i += 4) {
            const bi = a.vertices[i]!;
            if (bi < 0 || bi >= doc.bones.length || !Number.isInteger(bi)) {
              add("error", "weight-bone-index", `Weighted vertex ${v} references bone index ${bi} (bones: ${doc.bones.length})`, where);
              return;
            }
          }
          v++;
        }
        if (v !== vertexCount) add("error", "mesh-vertices", `Weighted vertex count ${v} != uv count ${vertexCount}`, where);
        const mixed = weightOrderConflicts(a);
        if (mixed) add("error", "weight-bone-order", `${mixed} weighted vertices list the same bones in different orders: Spine's import fails with "Index -2 out of bounds" (runtimes load it). Sort every vertex's bones by bone index: the pose does not change, and spine_rig_edit and spine_import_layers do it on their way in.`, where);
      }
    }
    if (type === "clipping" && a.end && !slots.has(a.end)) add("error", "missing-slot", `Clipping end slot "${a.end}" not found`, where);
    if (type === "clipping") {
      if (a.inverse) add("warning", "clip-inverse-lost", "Inverse clip: Spine 4.3.26's import drops inverse, so the project, its exports and the runtime clip to the inside instead.", where);
      const poly = a.vertices && a.vertices.length === (a.vertexCount ?? a.vertices.length / 2) * 2 ? a.vertices : null;
      if (poly && poly.length >= 8 && !convexPolygon(poly)) add("warning", "clip-concave", "Concave clipping polygon: Spine 4.3.26's import marks every clip convex, so it clips to the polygon's convex hull and the notch never cuts. Split it into convex clips, or move the parts between layers.", where);
    }
  }

  const slotIndex = new Map((doc.slots ?? []).map((s, i) => [s.name, i]));
  const clips = [...attachmentsBySlot].flatMap(([slot, m]) => [...m].filter(([, a]) => a.type === "clipping").map(([name, a]) => ({ slot, name, from: slotIndex.get(slot), to: a.end ? slotIndex.get(a.end) : (doc.slots ?? []).length - 1 })))
    .filter((c): c is { slot: string; name: string; from: number; to: number } => c.from !== undefined && c.to !== undefined);
  for (const outer of clips) {
    const inner = clips.filter((c) => c.slot !== outer.slot && c.from > outer.from && c.from <= outer.to);
    if (inner.length) add("warning", "clip-nested", `Clip "${outer.name}" (slot ${outer.slot}) runs over the clips of ${[...new Set(inner.map((c) => c.slot))].slice(0, 4).join(", ")}: a clip that starts while another is active is ignored by the runtime. End the outer clip before the inner one and start a second outer clip after it.`, `slots/${outer.slot}`);
  }

  const version = typeof doc.skeleton.spine === "string" ? doc.skeleton.spine.split(".").map(Number) : null;
  const legacy = (["ik", "transform", "path", "physics"] as const).filter((k) => Array.isArray(doc[k]) && (doc[k] as unknown[]).length);
  if (legacy.length && (!version || version[0]! > 4 || (version[0] === 4 && version[1]! >= 3))) {
    add(version ? "error" : "warning", "legacy-constraint-block", `Top-level ${legacy.join(", ")} array(s): that is the 4.2 layout, and the data says ${version ? `Spine ${doc.skeleton.spine}` : "no version"}. Spine 4.3 lists every constraint under "constraints" with a "type"; its import and spine-core drop these silently. Re-export for 4.3, or add them again (spine_rig_edit addIk).`, legacy[0]);
  }

  (doc.slots ?? []).forEach((s, i) => {
    if (!boneIndex.has(s.bone)) add("error", "missing-bone", `Slot "${s.name}" uses unknown bone "${s.bone}"`, `slots[${i}]`);
    if (s.attachment && !attachmentsBySlot.get(s.name)?.has(s.attachment)) {
      add("error", "missing-attachment", `Slot "${s.name}" setup attachment "${s.attachment}" not found in any skin`, `slots[${i}]`);
    }
  });

  // Bone -> properties a physics constraint drives ("rotate", "translate", "scale", "shear").
  const physicsBones = new Map<string, Set<string>>();
  for (const c of doc.constraints ?? []) {
    const where = `constraints/${c.name}`;
    const need = (bone: string | undefined, role: string) => {
      if (bone !== undefined && !boneIndex.has(bone)) add("error", "missing-bone", `${c.type} constraint "${c.name}" ${role} bone "${bone}" not found`, where);
    };
    for (const b of c.bones ?? []) need(b, "constrained");
    need(c.target, "target");
    need(c.source, "source");
    need(c.bone, c.type === "slider" ? "driver" : "constrained");
    if (c.slot !== undefined && !slots.has(c.slot)) add("error", "missing-slot", `Constraint "${c.name}" slot "${c.slot}" not found`, where);
    if (c.type === "slider" && c.animation && !animations[c.animation]) add("error", "missing-animation", `Slider "${c.name}" animation "${c.animation}" not found`, where);
    if (c.type === "physics" && c.bone) {
      const props = physicsBones.get(c.bone) ?? new Set<string>();
      if (c.rotate) props.add("rotate");
      if (c.x || c.y) props.add("translate");
      if (c.scaleX) props.add("scale");
      if (c.shearX) props.add("shear");
      physicsBones.set(c.bone, props);
    }
  }

  for (const [animName, anim] of Object.entries(animations)) {
    const physicsKeyed = new Set<string>();
    for (const t of iterateTimelines(anim)) {
      const base = `animations/${animName}/${t.kind}/${t.owner}`;
      const section = t.kind.split(".")[0]!;
      if (section === "bone" && !boneIndex.has(t.owner)) add("error", "missing-bone", `Animation "${animName}" keys unknown bone "${t.owner}" (Spine drops it on import)`, base);
      if (section === "slot" && !slots.has(t.owner)) add("error", "missing-slot", `Animation "${animName}" keys unknown slot "${t.owner}"`, base);
      if (["ik", "transform", "physics", "slider", "path"].includes(section) && t.owner && !constraints.has(`${section}:${t.owner}`)) {
        add("error", "missing-constraint", `Animation "${animName}" keys unknown ${section} constraint "${t.owner}"`, base);
      }
      const prop = t.kind.split(".")[1]?.replace(/[xy]$/, "") ?? "";
      if (section === "bone" && physicsBones.get(t.owner)?.has(prop)) physicsKeyed.add(`${t.owner}.${prop}`);
      checkKeys(t.kind, t.keys, base);
      if (t.kind === "slot.attachment") {
        for (const [i, k] of t.keys.entries()) {
          if (k.name === "") add("error", "empty-attachment-name", `Attachment key with an empty name in slot "${t.owner}": Spine imports it as a different key. Leave name out to hide the attachment.`, `${base}[${i}]`);
          if (k.name && !attachmentsBySlot.get(t.owner)?.has(k.name)) {
            add("error", "missing-attachment", `Attachment key "${k.name}" not found for slot "${t.owner}" (Spine drops it on import)`, `${base}[${i}]`);
          }
        }
      }
      if (t.attachment) {
        const { skin: skinName, slot, name: att } = t.attachment;
        const skin = skinByName.get(skinName);
        if (!skin) add("error", "missing-skin", `Animation "${animName}" keys attachments of unknown skin "${skinName}"`, base);
        else if (!slots.has(slot)) add("error", "missing-slot", `Animation "${animName}" keys attachments of unknown slot "${slot}"`, base);
        else if (!skin.attachments?.[slot]?.[att]) add("error", "missing-attachment", `Animation "${animName}" keys attachment "${att}" not found in skin "${skinName}" slot "${slot}"`, base);
      }
      if (t.kind === "drawOrder" || t.kind === "drawOrderFolder") {
        for (const [i, k] of t.keys.entries()) {
          for (const o of (k.offsets as { slot: string }[] | undefined) ?? []) {
            if (!slots.has(o.slot)) add("error", "missing-slot", `Draw order key references unknown slot "${o.slot}"`, `${base}[${i}]`);
          }
        }
      }
      if (t.kind === "events") {
        for (const [i, k] of t.keys.entries()) {
          if (k.name && !(doc.events ?? {})[k.name]) add("error", "missing-event", `Event "${k.name}" is not defined`, `${base}[${i}]`);
        }
      }
    }
    // Common and valid (physics adds motion on top of keys), but worth knowing when a key "does nothing" or snaps.
    if (physicsKeyed.size) {
      add("info", "physics-bone-keyed", `Animation "${animName}" keys properties that physics also drives: ${[...physicsKeyed].join(", ")}`, `animations/${animName}`);
    }
  }

  function checkKeys(kind: string, keys: Key[], base: string) {
    let prev = -Infinity;
    const channels = CHANNELS[kind] ?? 1;
    keys.forEach((k, i) => {
      const time = k.time ?? 0;
      if (time < prev) add("error", "key-order", `Key times must not decrease (${time} after ${prev})`, `${base}[${i}]`);
      prev = time;
      if (Array.isArray(k.curve) && k.curve.length !== channels * 4) {
        add("warning", "curve-shape", `Bezier curve has ${k.curve.length} numbers, expected ${channels * 4}`, `${base}[${i}]`);
      }
    });
  }

  for (const [animName, anim] of Object.entries(animations)) {
    for (const folder of ((anim.drawOrderFolder as { slots?: string[] }[] | undefined) ?? [])) {
      for (const sl of folder.slots ?? []) if (!slots.has(sl)) add("error", "missing-slot", `Draw order folder references unknown slot "${sl}"`, `animations/${animName}/drawOrderFolder`);
    }
  }

  const gridFps = opts.fps ?? doc.skeleton.fps ?? 30;
  const loopNames = new Set(opts.loopAnimations ?? Object.keys(animations).filter((n) => LOOP_NAME.test(n) && !NOT_LOOP_NAME.test(n)));
  for (const [animName, anim] of Object.entries(animations)) {
    const h = keyHygiene(anim, gridFps);
    const where = `animations/${animName}`;
    if (h.offFrame) add("info", "key-off-frame", `"${animName}": ${h.offFrame} of ${h.keys} keys sit between frames at ${gridFps} fps (${h.offFrameExamples.join(", ")}${h.offFrame > h.offFrameExamples.length ? ", ..." : ""}). Put keys on whole frames.`, where);
    if (h.dense.length) add("info", "key-dense", `"${animName}": ${h.dense.length} timeline(s) keyed on almost every frame, like a bake (${h.dense.slice(0, 5).join(", ")}${h.dense.length > 5 ? ", ..." : ""}). A few eased keys are easier to edit and do not kink.`, where);
    if (h.longValues) add("info", "key-long-decimals", `"${animName}": ${h.longValues} key value(s) finer than whole or .5 degrees and units, or 0.01 for scale and mix (${h.longValueExamples.join(", ")}${h.longValues > h.longValueExamples.length ? ", ..." : ""}).`, where);
    if (h.lateEnds.length && loopNames.has(animName)) add("info", "timeline-end-mismatch", `Loop "${animName}": ${h.lateEnds.length} timeline(s) end after the rest (${h.lateEnds.slice(0, 4).join(", ")}): the loop gets longer and everything else holds still until they end.`, where);
  }

  const blocked = issues.some((i) => i.severity === "error");
  if (opts.runtime !== false && (!blocked || opts.runtimeAnimations)) runtimeChecks(doc, opts, add);
  return issues;
}

function runtimeChecks(doc: SkeletonJson, opts: ValidateOptions, add: (s: Severity, c: string, m: string, w?: string) => void) {
  let data;
  try {
    data = loadSkeletonData(doc);
  } catch (e) {
    add("error", "runtime-load", `spine-core 4.3 failed to load the skeleton: ${(e as Error).message}`);
    return;
  }
  const loops = new Set(opts.loopAnimations ?? data.animations.map((a) => a.name).filter((n) => LOOP_NAME.test(n) && !NOT_LOOP_NAME.test(n)));
  for (const anim of data.animations) {
    if (opts.runtimeAnimations && !opts.runtimeAnimations.includes(anim.name)) continue;
    const where = `animations/${anim.name}`;
    let sampled;
    try {
      sampled = sampleAnimation(data, anim.name, { fps: opts.fps });
    } catch (e) {
      add("error", "runtime-sample", `Sampling "${anim.name}" failed: ${(e as Error).message}`, where);
      continue;
    }
    if (sampled.nanFrames.length) add("error", "nan-pose", `NaN world transforms on ${sampled.nanFrames.length} frame(s), first at frame ${sampled.nanFrames[0]}`, where);
    clampChecks(data, anim, opts.fps ?? 30, where, add);
    for (const f of foldIssues(data, anim, opts.fps ?? 30)) add(f.severity, f.code, f.message, where);
    for (const f of jointIssues(data, anim, opts.fps ?? 30, opts.images)) add(f.severity, f.code, f.message, where);
    if (!loops.has(anim.name) || anim.duration === 0) continue;
    const report = measureMotion(sampled);
    // Ratio catches pops relative to the motion; the absolute floor ignores sub-pixel jitter on slow bones.
    const bad = report.bones.filter((b) => b.moving && b.seam.ratio > 4 && b.seam.position + b.seam.rotation > 1).sort((a, b) => b.seam.ratio - a.seam.ratio);
    if (bad.length) {
      const top = bad.slice(0, 5).map((b) => `${b.bone} (${b.seam.ratio}x)`).join(", ");
      add("warning", "loop-seam", `Loop "${anim.name}" jumps at the seam on ${bad.length} bone(s): ${top} (seam step vs neighbouring steps; intentional for resets such as particles)`, where);
    }
  }
}

/**
 * Clamped transform constraints driven past their range: the source keeps moving while the driven bone has stopped
 * at its limit (and bones with different limits on one source, such as two eyes on one look bone, stop at different
 * points). Reports the largest overshoot per constraint, in the driven property's units.
 */
function clampChecks(data: spine.SkeletonData, anim: spine.Animation, fps: number, where: string, add: (s: Severity, c: string, m: string, w?: string) => void) {
  const clamped = data.constraints.filter((c): c is spine.TransformConstraintData => c instanceof spine.TransformConstraintData && c.clamp);
  if (!clamped.length || !(anim.duration > 0)) return;
  const sk = new spine.Skeleton(data);
  const worst = new Map<string, { over: number; time: number; source: string; target: string }>();
  const n = Math.max(1, Math.round(anim.duration * fps));
  for (let f = 0; f <= n; f++) {
    const t = (anim.duration * f) / n;
    sk.setupPose();
    anim.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
    sk.updateWorldTransform(spine.Physics.none);
    for (const c of sk.constraints) {
      if (!(c instanceof spine.TransformConstraint) || !c.data.clamp) continue;
      const d = c.data, source = c.source.appliedPose;
      if (d.localSource) source.validateLocalTransform(sk);
      for (const from of d.properties) {
        const value = from.value(sk, source, d.localSource, d.offsets) - from.offset;
        for (const to of from.to) {
          const raw = to.offset + value * to.scale;
          const lo = Math.min(to.offset, to.max), hi = Math.max(to.offset, to.max);
          const over = raw < lo ? lo - raw : raw > hi ? raw - hi : 0;
          const prev = worst.get(d.name);
          if (over > 0.5 && (!prev || over > prev.over)) worst.set(d.name, { over, time: t, source: c.source.data.name, target: d.bones.map((b) => b.name).join(", ") });
        }
      }
    }
  }
  for (const [name, w] of worst) {
    add("warning", "constraint-clamped", `"${anim.name}" drives ${w.source} past the range of constraint ${name}: ${w.target} stops at its limit (${+w.over.toFixed(2)} beyond it at ${+w.time.toFixed(3)}s) while ${w.source} keeps going. Keep ${w.source} inside the range, or the eyes (or whatever it drives) freeze and drift apart.`, where);
  }
}

function convexPolygon(v: number[]): boolean {
  const n = v.length / 2;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const ax = v[i * 2]!, ay = v[i * 2 + 1]!, bx = v[((i + 1) % n) * 2]!, by = v[((i + 1) % n) * 2 + 1]!, cx = v[((i + 2) % n) * 2]!, cy = v[((i + 2) % n) * 2 + 1]!;
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-6) continue;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

export function issueCounts(issues: Issue[]) {
  return {
    errors: issues.filter((i) => i.severity === "error").length,
    warnings: issues.filter((i) => i.severity === "warning").length,
    info: issues.filter((i) => i.severity === "info").length,
  };
}
