// compareTracks with physics on: simulated bones compared apart, non-finite values caught, the spawn kick measured.
import { describe, expect, it } from "vitest";
import { loadSkeletonData, spine } from "../src/spine/runtime.js";
import type { SkeletonJson } from "../src/spine/types.js";
import { compareTracks } from "../src/spine/unity.js";

/** A pole that swings far from its setup pose from the first frame, with a physics-driven tassel on it. */
function rig(): SkeletonJson {
  return {
    skeleton: { spine: "4.3.26" },
    bones: [{ name: "root" }, { name: "pole", parent: "root", length: 200 }, { name: "tassel", parent: "pole", x: 200, length: 80 }, { name: "tip", parent: "tassel", x: 80 }],
    slots: [], skins: [{ name: "default", attachments: {} }],
    constraints: [{ type: "physics", name: "tassel-physics", bone: "tassel", rotate: 1, inertia: 0.5, strength: 100, damping: 0.85, mass: 1, mix: 1 }],
    animations: { swing: { bones: { pole: { rotate: [{ value: 90 }, { time: 1, value: 60 }, { time: 2, value: 90 }] } } } },
  } as unknown as SkeletonJson;
}

/** Frames as the Unity script records them: SkeletonRenderer.Initialize at the setup pose, then Update, pose, Physics.Update. */
function frames(data: spine.SkeletonData, n: number): number[][] {
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  const state = new spine.AnimationState(new spine.AnimationStateData(data));
  state.setAnimation(0, "swing", true);
  sk.updateWorldTransform(spine.Physics.update);
  const dt = Math.fround(1 / 30), out: number[][] = [];
  for (let k = 0; k < n; k++) {
    if (k > 0) {
      sk.update(dt);
      sk.time = Math.fround(sk.time);
      state.update(dt);
      for (const e of state.tracks) if (e) { e.trackTime = Math.fround(e.trackTime); e.animationLast = Math.fround(e.animationLast); e.nextAnimationLast = Math.fround(e.nextAnimationLast); }
    }
    state.apply(sk);
    sk.updateWorldTransform(spine.Physics.update);
    out.push(sk.bones.flatMap((b) => [b.appliedPose.worldX, b.appliedPose.worldY, b.appliedPose.getWorldRotationX()]));
  }
  return out;
}

describe("tracks with physics on", () => {
  it("compares simulated bones apart and measures the kick the jump from the setup pose gives them on spawn", () => {
    const data = loadSkeletonData(rig());
    const unity = frames(data, 121);
    const r = compareTracks(data, ["swing"], 4, unity, true);
    expect(r.ok).toBe(true);
    expect(r.physics).toMatchObject({ bones: ["tassel", "tip"], finite: true, ok: true });
    expect(r.physics!.maxPositionError).toBeLessThan(1e-6); // same stepping on both sides: this checks the plumbing only
    // The pole starts at 90 degrees, not at its setup 0: the tassel is thrown, then settles.
    expect(r.physics!.startup.maxOffset).toBeGreaterThan(20);
    expect(r.physics!.startup.bone).toBe("tip");
    expect(r.physics!.startup.settlesAt).toBeGreaterThan(0);
    // Without physics the same tracks compare every bone, and no physics block is returned.
    expect(compareTracks(data, ["swing"], 4, unity, false).physics).toBeUndefined();
  });

  it("fails on non-finite values from Unity (a simulation that blew up)", () => {
    const data = loadSkeletonData(rig());
    const unity = frames(data, 31);
    unity[20]![3 * 3] = null as never; // tip x: SpineMcpCheck writes a NaN or infinity as null
    expect(compareTracks(data, ["swing"], 1, unity, true).physics).toMatchObject({ finite: false, ok: false });
  });
});
