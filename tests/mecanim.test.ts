import { describe, expect, it } from "vitest";
import { deriveAnimationWithNotes } from "../src/spine/derive.js";
import { mixCheck } from "../src/spine/mix.js";
import { loadSkeletonData } from "../src/spine/runtime.js";
import { missingTimelines } from "../src/spine/setupkeys.js";
import type { SkeletonJson } from "../src/spine/types.js";

const rot = (v: number, t = 0) => ({ time: t, value: v });

/** wave keys the arm; idle only breathes the body and never keys the arm. */
function rig(): SkeletonJson {
  return {
    skeleton: { spine: "4.3.26" },
    bones: [{ name: "root" }, { name: "body", parent: "root", length: 50 }, { name: "arm", parent: "body", length: 100 }, { name: "hand", parent: "arm", x: 100, length: 20 }],
    slots: [{ name: "face", bone: "body", attachment: "smile" }],
    skins: [{ name: "default", attachments: {} }],
    constraints: [],
    animations: {
      wave: { bones: { arm: { rotate: [rot(70), rot(80, 0.5), rot(70, 1)] } }, slots: { face: { attachment: [{ name: "open" }] } } },
      idle: { bones: { body: { rotate: [rot(0), rot(2, 1), rot(0, 2)] } } },
    },
  } as unknown as SkeletonJson;
}

describe("SkeletonMecanim transitions (spine-unity's MixNext + autoReset)", () => {
  it("a property only the outgoing clip keys snaps to setup when the transition ends; AnimationState mixes it out", () => {
    const doc = rig();
    const data = loadSkeletonData(doc);
    const t = [{ from: "wave", to: "idle", mix: 0.25 }];
    const mec = mixCheck(data, doc.animations!, { transitions: t, runtime: "mecanim", at: [0.5] });
    const pop = mec.transitions[0]!.pops[0]!;
    expect(["arm", "hand"]).toContain(pop.bone);
    expect(pop.phase).toBe("mix end"); // held at the wave pose, then gone in one frame
    expect(pop.cause).toMatch(/wave keys rotate arm and idle does not: SkeletonMecanim .* setupKeys/);
    expect(mec.mecanimMissingKeys).toEqual([{ animation: "idle", timelines: 2, examples: ["bone.rotate arm", "slot.attachment face"] }]);
    // trace: the hand's path, plotted from just before the switch; Mecanim's ends in a jump, AnimationState's does not.
    const traced = mixCheck(data, doc.animations!, { transitions: t, runtime: "mecanim", at: [0.5], trace: "hand" }).transitions[0]!.trace!;
    expect(traced).toMatchObject({ bone: "hand", fps: 60, switchFrame: 6 });
    const steps = traced.points.slice(1).map((p, i) => Math.hypot(p[0] - traced.points[i]![0], p[1] - traced.points[i]![1]));
    expect(Math.max(...steps)).toBeGreaterThan(50);
    const smooth = mixCheck(data, doc.animations!, { transitions: t, at: [0.5], trace: "hand" }).transitions[0]!.trace!;
    expect(Math.max(...smooth.points.slice(1).map((p, i) => Math.hypot(p[0] - smooth.points[i]![0], p[1] - smooth.points[i]![1])))).toBeLessThan(20);
    // The same transition through AnimationState is a smooth mix.
    expect(mixCheck(data, doc.animations!, { transitions: t, at: [0.5] }).transitions[0]!.ok).toBe(true);
  });

  it("setupKeys adds the missing setup keys and the transition blends instead of snapping", () => {
    const doc = rig();
    const r = deriveAnimationWithNotes(doc.animations!.idle!, [{ op: "setupKeys" }], { skeleton: doc });
    expect(r.animation.bones!.arm).toEqual({ rotate: [{ value: 0 }] });
    expect(r.animation.slots!.face).toEqual({ attachment: [{ name: "smile" }] });
    expect(r.animation.bones!.body).toEqual(doc.animations!.idle!.bones!.body); // own keys untouched
    expect(r.notes[0]).toMatch(/2 timeline\(s\) keyed to the setup pose/);
    const fixed = { ...doc, animations: { ...doc.animations!, idle: r.animation } };
    expect(missingTimelines(fixed, "idle")).toEqual([]);
    const mec = mixCheck(loadSkeletonData(fixed), fixed.animations!, { transitions: [{ from: "wave", to: "idle", mix: 0.25 }], runtime: "mecanim", at: [0.5] });
    expect(mec.transitions[0]!.ok).toBe(true);
    expect(mec.mecanimMissingKeys).toEqual([]);
  });

  it("leaves bones driven by physics to the simulation, but brings the physics mix back", () => {
    const doc = rig();
    doc.constraints = [{ type: "physics", name: "arm-physics", bone: "arm", rotate: 1, mix: 1 } as never];
    // A baked wave: rotation keys on the physics bone, physics mix keyed to 0.
    doc.animations!.wave!.physics = { "arm-physics": { mix: [{ value: 0 }] } } as never;
    expect(missingTimelines(doc, "idle").map((m) => `${m.kind} ${m.owner}`)).toEqual(["slot.attachment face", "physics.mix arm-physics"]);
    const r = deriveAnimationWithNotes(doc.animations!.idle!, [{ op: "setupKeys" }], { skeleton: doc });
    expect(r.animation.bones!.arm).toBeUndefined();
    expect((r.animation.physics as Record<string, Record<string, unknown>>)["arm-physics"]).toEqual({ mix: [{ value: 1 }] });
  });

  it("simulates the other mix modes and autoReset off: AlwaysMix fades, Hard cuts, Match is MixNext, no reset holds the pose", () => {
    const doc = rig();
    const data = loadSkeletonData(doc);
    const t = [{ from: "wave", to: "idle", mix: 0.25 }];
    const run = (mecanimMode?: "mixNext" | "alwaysMix" | "hard" | "match", autoReset?: boolean) => mixCheck(data, doc.animations!, { transitions: t, runtime: "mecanim", at: [0.5], mecanimMode, autoReset, trace: "hand" }).transitions[0]!;
    // AlwaysMix weighs wave by 1 - w from the setup pose: the arm fades out, nothing snaps.
    const always = run("alwaysMix");
    expect(always.ok).toBe(true);
    const steps = (r: typeof always) => r.trace!.points.slice(1).map((p, i) => Math.hypot(p[0] - r.trace!.points[i]![0], p[1] - r.trace!.points[i]![1]));
    expect(Math.max(...steps(always))).toBeLessThan(20);
    // Hard: still held at the wave pose, then the snap at the end.
    expect(run("hard").pops[0]).toMatchObject({ phase: "mix end" });
    // Match with one clip per state resolves to MixNext's weights (the simulation takes the same path; the Unity
    // integration test checks Unity's Match against it).
    expect(run("match").trace!.points).toEqual(run().trace!.points);
    // autoReset off: no snap, but the arm never leaves the wave pose.
    const noReset = run("mixNext", false);
    expect(noReset.pops).toEqual([]);
    expect(noReset.ok).toBe(false);
    expect(noReset.held!.map((h) => h.bone)).toEqual(expect.arrayContaining(["arm", "hand"]));
    expect(run().held).toEqual([]);
    expect(() => mixCheck(data, doc.animations!, { transitions: t, autoReset: false })).toThrow(/need runtime mecanim/);
  });

  it("keys constraints and colours at their setup values", () => {
    const doc = rig();
    doc.slots![0]!.color = "ff000080";
    doc.constraints = [{ type: "ik", name: "reach", bones: ["arm", "hand"], target: "body", mix: 0.5, bendPositive: false } as never];
    doc.animations!.wave!.ik = { reach: [{ mix: 1 }] };
    doc.animations!.wave!.slots!.face!.rgba = [{ color: "ffffffff" }];
    const r = deriveAnimationWithNotes(doc.animations!.idle!, [{ op: "setupKeys", from: ["wave"] }], { skeleton: doc });
    expect(r.animation.ik!.reach).toEqual([{ mix: 0.5, softness: 0, bendPositive: false, compress: false, stretch: false }]);
    expect(r.animation.slots!.face!.rgba).toEqual([{ color: "ff000080" }]);
  });
});

describe("events inside a mix window", () => {
  const doc = {
    skeleton: { spine: "4.3.26" },
    bones: [{ name: "root" }, { name: "leg", parent: "root", length: 50 }],
    slots: [], skins: [{ name: "default", attachments: {} }], constraints: [],
    events: { step: {} },
    animations: {
      walk: { bones: { leg: { rotate: [rot(-20), rot(20, 0.5), rot(-20, 1)] } }, events: [{ time: 0.2, name: "step" }, { time: 0.7, name: "step" }] },
      idle: { bones: { leg: { rotate: [rot(0), rot(0, 1)] } } },
    },
  } as unknown as SkeletonJson;

  it("reports the outgoing animation's events the mix swallows (eventThreshold 0), and none when the threshold lets them through", () => {
    const data = loadSkeletonData(doc);
    const t = [{ from: "walk", to: "idle", mix: 0.3 }];
    const r = mixCheck(data, doc.animations!, { transitions: t, at: [0.5] });
    expect(r.transitions[0]!.lostEvents).toEqual([{ event: "step", time: 0.7, at: 0.5 }]); // 0.5 s + 0.3 s mix covers it
    expect(r.notes.join(" ")).toMatch(/lose events.*eventThreshold 0/);
    expect(mixCheck(data, doc.animations!, { transitions: t, at: [0.5], eventThreshold: 1 }).transitions[0]!.lostEvents).toEqual([]);
    // Outside the window nothing is lost.
    expect(mixCheck(data, doc.animations!, { transitions: [{ from: "walk", to: "idle", mix: 0.1 }], at: [0.5] }).transitions[0]!.lostEvents).toEqual([]);
  });
});
