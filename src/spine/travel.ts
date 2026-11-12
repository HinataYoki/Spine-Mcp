import { spine } from "./runtime.js";
import { sampleAnimation, type SampleOptions } from "./sample.js";

export interface PartTravel {
  slot: string;
  edge: number;
  centre: number;
  frames: number;
  swaps: number;
  reads: "still" | "small" | "clear" | "large";
}

export interface PartTravelReport {
  scale: number;
  unit: "units" | "px";
  parts: PartTravel[];
  still: string[];
  notes: string[];
}

interface Track { attachment: string; rest: number[]; centre: [number, number]; edge: number; centreTravel: number; frames: number; last: string | null; swaps: number }

export function outline(skeleton: spine.Skeleton, slot: spine.Slot): number[] | null {
  const att = slot.pose.getAttachment();
  if (att instanceof spine.RegionAttachment) {
    const v = new Array<number>(8).fill(0);
    att.computeWorldVertices(slot, att.getOffsets(slot.pose), v, 0, 2);
    return v;
  }
  if (att instanceof spine.MeshAttachment) {
    const v = new Array<number>(att.worldVerticesLength).fill(0);
    att.computeWorldVertices(skeleton, slot, 0, att.worldVerticesLength, v, 0, 2);
    return att.hullLength >= 6 ? v.slice(0, att.hullLength) : v;
  }
  return null;
}

function toPolyline(p: number[], x: number, y: number): number {
  let best = Infinity;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = p[i * 2]!, ay = p[i * 2 + 1]!, bx = p[((i + 1) % n) * 2]!, by = p[((i + 1) % n) * 2 + 1]!;
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

const centroid = (p: number[]): [number, number] => {
  let x = 0, y = 0;
  for (let i = 0; i < p.length; i += 2) { x += p[i]!; y += p[i + 1]!; }
  return [(x * 2) / p.length, (y * 2) / p.length];
};

export const readsAs = (px: number): PartTravel["reads"] => (px < 1.5 ? "still" : px < 4 ? "small" : px < 15 ? "clear" : "large");

export function partTravel(data: spine.SkeletonData, animation: string, scale = 1, opts: Omit<SampleOptions, "onFrame" | "bones"> = {}): PartTravelReport {
  const tracks = new Map<string, Track>();
  const onFrame = (skeleton: spine.Skeleton) => {
    for (const slot of skeleton.slots) {
      const name = slot.data.name;
      const att = slot.pose.getAttachment();
      const key = slot.pose.color.a > 0.01 && slot.bone.active && att ? att.name : null;
      let t = tracks.get(name);
      if (t) {
        if (t.last !== key) t.swaps++;
        t.last = key;
      }
      if (!key) continue;
      const p = outline(skeleton, slot);
      if (!p) continue;
      if (!t) {
        t = { attachment: key, rest: p, centre: centroid(p), edge: 0, centreTravel: 0, frames: 0, last: key, swaps: 0 };
        tracks.set(name, t);
      }
      if (t.attachment !== key) continue;
      for (let i = 0; i < p.length; i += 2) t.edge = Math.max(t.edge, toPolyline(t.rest, p[i]!, p[i + 1]!));
      const c = centroid(p);
      t.centreTravel = Math.max(t.centreTravel, Math.hypot(c[0] - t.centre[0], c[1] - t.centre[1]));
      t.frames++;
    }
  };
  sampleAnimation(data, animation, { ...opts, bones: [data.bones[0]!.name], onFrame });
  const parts: PartTravel[] = [...tracks].map(([slot, t]) => ({
    slot, edge: +(t.edge * scale).toFixed(2), centre: +(t.centreTravel * scale).toFixed(2), frames: t.frames, swaps: t.swaps, reads: readsAs(t.edge * scale),
  }));
  parts.sort((a, b) => b.edge - a.edge);
  return {
    scale, unit: scale === 1 ? "units" : "px", parts, still: parts.filter((p) => p.reads === "still").map((p) => p.slot),
    notes: [
      "edge: the farthest any point of the part's outline (mesh hull, or a region's rectangle) gets from its outline in the first frame; centre: the farthest its centre gets from where it starts. Frames where the slot shows another attachment are left out (swaps counts the changes).",
      "reads: still under 1.5, small under 4, clear under 15, large from 15 (in px when scale is px per unit on the target screen).",
    ],
  };
}
