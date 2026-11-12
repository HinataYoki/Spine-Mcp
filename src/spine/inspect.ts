import type { AnimationJson, Key, SkeletonJson, TimelineMap } from "./types.js";

export interface AnimationSummary {
  name: string;
  /** Last key time over all timelines (Spine's animation duration). */
  duration: number;
  keys: number;
  /** Timeline count per kind, e.g. { "bone.rotate": 12, "slot.attachment": 2, "physics": 1 }. */
  timelines: Record<string, number>;
  keyedBones: string[];
  keyedSlots: string[];
  curves: { linear: number; stepped: number; bezier: number };
  events: number;
}

export interface SkeletonSummary {
  name: string;
  spineVersion?: string;
  hash?: string;
  size: { width?: number; height?: number };
  fps?: number;
  counts: { bones: number; slots: number; skins: number; constraints: number; animations: number; events: number };
  constraints: Record<string, string[]>;
  attachments: Record<string, number>;
  boneTree: string;
  animations: AnimationSummary[];
}

/** Every key list of an animation with a "<section>.<property>" kind label. Attachment timelines also carry their
 * skin/slot/attachment separately: names may contain "/" (4.3 slot folders), so `owner` cannot be split. */
export function* iterateTimelines(anim: AnimationJson): Generator<{ kind: string; owner: string; keys: Key[]; attachment?: { skin: string; slot: string; name: string } }> {
  const maps: [string, Record<string, TimelineMap> | undefined][] = [["bone", anim.bones], ["slot", anim.slots], ["path", anim.path]];
  for (const [section, map] of maps) {
    for (const [owner, timelines] of Object.entries(map ?? {})) {
      for (const [prop, keys] of Object.entries(timelines)) yield { kind: `${section}.${prop}`, owner, keys };
    }
  }
  for (const section of ["ik", "transform"] as const) {
    for (const [owner, keys] of Object.entries(anim[section] ?? {})) yield { kind: section, owner, keys };
  }
  for (const section of ["physics", "slider"] as const) {
    for (const [owner, value] of Object.entries(anim[section] ?? {})) {
      if (Array.isArray(value)) yield { kind: section, owner, keys: value };
      else for (const [prop, keys] of Object.entries(value)) yield { kind: `${section}.${prop}`, owner, keys };
    }
  }
  for (const [skin, slots] of Object.entries(anim.attachments ?? {})) {
    for (const [slot, atts] of Object.entries(slots)) {
      for (const [att, timelines] of Object.entries(atts)) {
        for (const [prop, keys] of Object.entries(timelines)) {
          yield { kind: `attachment.${prop}`, owner: `${skin}/${slot}/${att}`, keys, attachment: { skin, slot, name: att } };
        }
      }
    }
  }
  if (anim.drawOrder) yield { kind: "drawOrder", owner: "", keys: anim.drawOrder };
  for (const [i, folder] of (anim.drawOrderFolder ?? []).entries()) yield { kind: "drawOrderFolder", owner: `#${i}`, keys: folder.keys ?? [] };
  if (anim.events) yield { kind: "events", owner: "", keys: anim.events };
}

export function animationDuration(anim: AnimationJson): number {
  let d = 0;
  for (const { keys } of iterateTimelines(anim)) for (const k of keys) d = Math.max(d, k.time ?? 0);
  return d;
}

export function summarizeAnimation(name: string, anim: AnimationJson): AnimationSummary {
  const timelines: Record<string, number> = {};
  const curves = { linear: 0, stepped: 0, bezier: 0 };
  let keys = 0;
  for (const t of iterateTimelines(anim)) {
    timelines[t.kind] = (timelines[t.kind] ?? 0) + 1;
    keys += t.keys.length;
    if (t.kind === "events" || t.kind === "drawOrder" || t.kind === "drawOrderFolder") continue;
    t.keys.forEach((k, i) => {
      if (i === t.keys.length - 1) return; // the last key's curve never applies
      if (k.curve === undefined) curves.linear++;
      else if (k.curve === "stepped") curves.stepped++;
      else curves.bezier++;
    });
  }
  return {
    name, duration: +animationDuration(anim).toFixed(4), keys, timelines,
    keyedBones: Object.keys(anim.bones ?? {}), keyedSlots: Object.keys(anim.slots ?? {}),
    curves, events: anim.events?.length ?? 0,
  };
}

export function boneTree(doc: SkeletonJson, maxLines = 400): string {
  const children = new Map<string, string[]>();
  for (const b of doc.bones) if (b.parent) children.set(b.parent, [...(children.get(b.parent) ?? []), b.name]);
  const lines: string[] = [];
  const walk = (name: string, depth: number) => {
    if (lines.length >= maxLines) return;
    lines.push(`${"  ".repeat(depth)}${name}`);
    for (const c of children.get(name) ?? []) walk(c, depth + 1);
  };
  for (const b of doc.bones) if (!b.parent) walk(b.name, 0);
  if (lines.length >= maxLines) lines.push(`… (${doc.bones.length} bones total)`);
  return lines.join("\n");
}

export function summarizeSkeleton(name: string, doc: SkeletonJson): SkeletonSummary {
  const constraints: Record<string, string[]> = {};
  for (const c of doc.constraints ?? []) (constraints[c.type] ??= []).push(c.name);
  const attachments: Record<string, number> = {};
  for (const skin of doc.skins ?? []) {
    for (const slot of Object.values(skin.attachments ?? {})) {
      for (const a of Object.values(slot)) attachments[a.type ?? "region"] = (attachments[a.type ?? "region"] ?? 0) + 1;
    }
  }
  const anims = Object.entries(doc.animations ?? {});
  return {
    name, spineVersion: doc.skeleton.spine, hash: doc.skeleton.hash,
    size: { width: doc.skeleton.width, height: doc.skeleton.height }, fps: doc.skeleton.fps,
    counts: {
      bones: doc.bones.length, slots: doc.slots?.length ?? 0, skins: doc.skins?.length ?? 0,
      constraints: doc.constraints?.length ?? 0, animations: anims.length, events: Object.keys(doc.events ?? {}).length,
    },
    constraints, attachments, boneTree: boneTree(doc),
    animations: anims.map(([n, a]) => summarizeAnimation(n, a)),
  };
}

/** Full detail of one animation: every timeline with its keys, for reading exact values. */
export function animationDetail(anim: AnimationJson) {
  return [...iterateTimelines(anim)].map((t) => ({ kind: t.kind, owner: t.owner, keys: t.keys }));
}
