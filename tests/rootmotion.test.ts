import { describe, expect, it } from "vitest";
import { rootMotionReport } from "../src/spine/rootmotion.js";
import type { SkeletonJson } from "../src/spine/types.js";

const lin = (prop: "x", pairs: [number, number][]) => pairs.map(([t, v]) => ({ ...(t ? { time: t } : {}), [prop]: v, y: 0 }));

/** root -> hip -> foot (length 10, pointing down). */
function rig(animations: SkeletonJson["animations"]): SkeletonJson {
  return {
    skeleton: { spine: "4.3.26", height: 200 },
    bones: [{ name: "root" }, { name: "hip", parent: "root", y: 100 }, { name: "foot", parent: "hip", y: -90, rotation: -90, length: 10 }],
    slots: [], skins: [{ name: "default", attachments: {} }],
    animations,
  } as unknown as SkeletonJson;
}

describe("root motion readiness", () => {
  it("travel on the root with the foot held in place: feet stand still, 200 units per loop", () => {
    const doc = rig({ walk: { bones: { root: { translate: lin("x", [[0, 0], [1, 200]]) }, foot: { translate: lin("x", [[0, 0], [1, -200]]) } } } });
    const r = rootMotionReport(doc, "walk", { feet: ["foot"] });
    expect(r).toMatchObject({ bone: "root", perLoop: { x: 200, y: 0 }, speed: { x: 200, y: 0 }, inPlace: false });
    expect(r.feet![0]!.contactSpeed).toBeLessThan(1);
    expect(r.findings.join(" ")).toMatch(/Root motion on root: 200, 0 per loop.*Planted feet stand still/);
  });

  it("feet carried along by the root slide on the ground", () => {
    const doc = rig({ walk: { bones: { root: { translate: lin("x", [[0, 0], [1, 200]]) } } } });
    const r = rootMotionReport(doc, "walk", { feet: ["foot"] });
    expect(r.feet![0]!.contactSpeed).toBeCloseTo(200, 0);
    expect(r.findings.join(" ")).toMatch(/Planted feet still move in the skeleton \(foot 200 units\/s\)/);
  });

  it("travel keyed on the hip: spine-unity reads root unless rootMotionBoneName says hip", () => {
    const doc = rig({ walk: { bones: { hip: { translate: lin("x", [[0, 0], [1, 150]]) } } } });
    const r = rootMotionReport(doc, "walk");
    expect(r).toMatchObject({ bone: "root", inPlace: true, travelOn: [{ bone: "hip", x: 150, y: 0 }] });
    expect(r.findings[0]).toMatch(/root does not travel, but hip \(150, 0 per loop\) does: .*rootMotionBoneName is set to hip/);
    expect(rootMotionReport(doc, "walk", { bone: "hip" })).toMatchObject({ bone: "hip", perLoop: { x: 150, y: 0 }, inPlace: false });
  });

  it("an in-place cycle tells the game speed that keeps planted feet on the ground", () => {
    // Stance: the foot slides back 120 units in 0.6 s; then it swings forward (lifted) to loop.
    const doc = rig({ walk: { bones: { foot: { translate: [{ x: 60, y: 0 }, { time: 0.6, x: -60, y: 0 }, { time: 0.8, x: 0, y: 15 }, { time: 1, x: 60, y: 0 }] } } } });
    const r = rootMotionReport(doc, "walk", { feet: ["foot"] });
    expect(r.travelOn).toEqual([]);
    expect(r.findings[0]).toMatch(/In place: planted feet move at about 200 units\/s/);
  });
});
