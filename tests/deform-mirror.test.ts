import { describe, expect, it } from "vitest";
import { deriveAnimationWithNotes } from "../src/spine/derive.js";
import { loadSkeletonData, spine } from "../src/spine/runtime.js";
import type { AnimationJson, SkeletonJson } from "../src/spine/types.js";
import { validateSkeleton } from "../src/spine/validate.js";

// Arms mirrored about x = 0 (the right bone points at 180 - 30; mirrored local geometry is (x, -y)).
const PTS = [[0, 0], [40, 6], [44, -10], [12, -22], [25, -5]];
const flip = (pts: number[][]) => pts.map(([x, y]) => [x!, -y!]);
const mesh = (vertices: number[]) => ({
  type: "mesh", uvs: [0, 0, 1, 0, 1, 1, 0, 1, 0.5, 0.5], triangles: [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4], hull: 4, vertices, width: 50, height: 30,
});
const flat = (pts: number[][]) => pts.flat();
// Weighted: 70% on the arm (bone index 1 or 2), 30% on the centre bone (index 3), same local offsets for both entries.
const weighted = (pts: number[][], arm: number) => pts.flatMap(([x, y]) => [2, arm, x!, y!, 0.7, 3, x!, y!, 0.3]);
const FACE = [[0, -10], [0, 10], [20, -15], [20, 15], [30, 0]];

function rig(): SkeletonJson {
  return {
    skeleton: { spine: "4.3.26" },
    bones: [
      { name: "root" },
      { name: "arm-left", parent: "root", x: -50, rotation: 30, length: 40 },
      { name: "arm-right", parent: "root", x: 50, rotation: 150, length: 40 },
      { name: "center", parent: "root", rotation: 90, length: 30 },
    ],
    slots: ["arm-left", "arm-right", "hand-left", "hand-right", "tail-left", "tail-right", "face"].map((n) => ({
      name: n, bone: n.startsWith("face") ? "center" : n.endsWith("left") ? "arm-left" : "arm-right", attachment: n,
    })),
    skins: [{
      name: "default",
      attachments: {
        "arm-left": { "arm-left": mesh(flat(PTS)) },
        "arm-right": { "arm-right": mesh(flat(flip(PTS))) },
        "hand-left": { "hand-left": mesh(weighted(PTS, 1)) },
        "hand-right": { "hand-right": mesh(weighted(flip(PTS), 2)) },
        "tail-left": { "tail-left": mesh(flat(PTS)) },
        "tail-right": { "tail-right": mesh(flat(PTS.map(([x, y]) => [x! * 1.4, y! + 8]))) }, // not a mirror image
        face: { face: mesh(flat(FACE)) },
      },
    }],
    animations: {},
  } as unknown as SkeletonJson;
}

const deformKeys = (n: number) => [
  { vertices: new Array(n).fill(0) },
  { time: 0.5, vertices: Array.from({ length: n }, (_, i) => ((i * 7) % 11) - 5 + (i % 2) * 3), curve: [0.6, 0.2, 0.8, 1] },
  { time: 1, offset: 2, vertices: Array.from({ length: n - 4 }, (_, i) => (i % 3) * 4 - 2) },
];

const source: AnimationJson = {
  bones: { "arm-left": { rotate: [{ value: 0, curve: [0.3, 0, 0.7, 20] }, { time: 1, value: 20 }] } },
  attachments: {
    default: {
      "arm-left": { "arm-left": { deform: deformKeys(10) } },
      "hand-left": { "hand-left": { deform: deformKeys(20) } },
      "tail-left": { "tail-left": { deform: deformKeys(10) } },
      face: { face: { deform: deformKeys(10) } },
    },
  },
} as unknown as AnimationJson;

function worldVertices(data: spine.SkeletonData, anim: string, t: number, slotName: string): number[] {
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  data.findAnimation(anim)!.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
  sk.updateWorldTransform(spine.Physics.none);
  const slot = sk.findSlot(slotName)!;
  const att = slot.pose.getAttachment() as spine.MeshAttachment;
  const out = new Array<number>(att.worldVerticesLength).fill(0);
  att.computeWorldVertices(sk, slot, 0, att.worldVerticesLength, out, 0, 2);
  return out;
}

/** Every vertex of `b` sits on a vertex of `a` mirrored about x = 0. */
function expectMirror(a: number[], b: number[]) {
  for (let j = 0; j < b.length; j += 2) {
    const d = Math.min(...Array.from({ length: a.length / 2 }, (_, i) => Math.hypot(-a[i * 2]! - b[j]!, a[i * 2 + 1]! - b[j + 1]!)));
    expect(d).toBeLessThan(1e-3);
  }
}

describe("mirror: deform keys", () => {
  const doc = rig();
  const r = deriveAnimationWithNotes(source, [{ op: "mirror" }], { skeleton: doc });
  doc.animations = { src: source, mir: r.animation };
  const data = loadSkeletonData(doc);

  it("validates and reports what it mirrored and what it could not", () => {
    expect(validateSkeleton(doc, { runtime: false }).filter((i) => i.severity === "error")).toEqual([]);
    expect(r.notes.join("\n")).toMatch(/3 deform timeline\(s\) mirrored vertex by vertex/);
    expect(r.notes.join("\n")).toMatch(/deform not mirrored .*tail-left\/tail-left/);
  });

  for (const t of [0.25, 0.5, 0.8, 1]) {
    it(`deformed meshes land on the mirror image of the source at t=${t} (unweighted, weighted, in place)`, () => {
      for (const [a, b] of [["arm-left", "arm-right"], ["hand-left", "hand-right"], ["face", "face"]]) {
        try { expectMirror(worldVertices(data, "src", t, a!), worldVertices(data, "mir", t, b!)); } catch (e) { throw new Error(`${a}: ${(e as Error).message}`); }
      }
    });
  }
});
