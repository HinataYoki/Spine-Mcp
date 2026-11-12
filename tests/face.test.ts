// Face motion on a small synthetic face: lids that slide shut, lashes hidden while shut, blinks over pose changes, eye darts,
// and the face audit of existing animations.
import { describe, expect, it } from "vitest";
import { clampBox, gaze } from "../src/spine/face.js";
import { faceAudit } from "../src/spine/faceaudit.js";
import { blink, poseChanges } from "../src/spine/generate.js";
import { loadSkeletonData, spine } from "../src/spine/runtime.js";
import type { AnimationJson, SkeletonJson } from "../src/spine/types.js";
import { validateSkeleton } from "../src/spine/validate.js";

const region = (w = 10, h = 4) => ({ width: w, height: h });

function face(): SkeletonJson {
  return {
    skeleton: { spine: "4.3.26", height: 300 },
    bones: [
      { name: "root" }, { name: "head", parent: "root", y: 150, length: 60 },
      { name: "eye_l", parent: "head", x: 20, y: -15 }, { name: "eye_r", parent: "head", x: 20, y: 15 },
      { name: "lid_l", parent: "eye_l" }, { name: "lid_r", parent: "eye_r" },
      { name: "look", parent: "head", x: 40 },
    ],
    slots: [{ name: "lash_l", bone: "lid_l", attachment: "lash" }, { name: "lash_r", bone: "lid_r", attachment: "lash" }],
    skins: [{ name: "default", attachments: { lash_l: { lash: region() }, lash_r: { lash: region() } } }],
    animations: {
      // The animator's shut lids: slid down 9 units.
      shut: { bones: { lid_l: { translate: [{ x: 0, y: -9 }] }, lid_r: { translate: [{ x: 0, y: -9 }] } } },
      // Head holds, then turns fast at 1.0 s and again at 2.0 s.
      idle: { bones: { head: { rotate: [{ value: 0, curve: "stepped" }, { time: 1, value: 0 }, { time: 1.1, value: 8, curve: "stepped" }, { time: 2, value: 8 }, { time: 2.1, value: -4, curve: "stepped" }, { time: 3, value: -4 }] } } },
    },
  } as unknown as SkeletonJson;
}

function at(doc: SkeletonJson, anim: AnimationJson, t: number) {
  const data = loadSkeletonData({ ...doc, animations: { x: anim } } as SkeletonJson);
  const sk = new spine.Skeleton(data);
  sk.setupPose();
  data.findAnimation("x")!.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
  sk.updateWorldTransform(spine.Physics.none);
  return sk;
}

describe("blink with lids posed shut and lashes hidden", () => {
  it("slides the lids to the animator's shut pose, hides the lashes while shut, and holds before opening", () => {
    const doc = face();
    const { animation, notes } = blink(doc, { lids: [{ bone: "lid_l", closedFrom: "shut@0" }, { bone: "lid_r", closedFrom: "shut@0" }], hide: ["lash_l", "lash_r"], duration: 3, at: 1 });
    expect(notes[0]).toMatch(/1 blink\(s\) at 1s: shut in 0.0667s, held 0.0667s, open in 0.1s \(2 \/ 2 \/ 3 frames at 30 fps\).*Hidden while shut: lash_l, lash_r/);
    // Every key on the frame grid (Spine moves keys that sit just off a frame, with their curves).
    for (const tl of [...Object.values(animation.bones!.lid_l!), animation.slots!.lash_l!.attachment!]) for (const k of tl) expect(Math.abs((k.time ?? 0) * 30 - Math.round((k.time ?? 0) * 30))).toBeLessThan(1e-4);
    const shut = at(doc, animation, 1.07 + 0.025), open = at(doc, animation, 1.25);
    expect(shut.findBone("lid_l")!.pose.y).toBeCloseTo(-9, 3);
    expect(shut.findSlot("lash_l")!.pose.getAttachment()).toBeNull();
    expect(open.findBone("lid_l")!.pose.y).toBeCloseTo(0, 3);
    expect(open.findSlot("lash_l")!.pose.getAttachment()?.name).toBe("lash");
    expect(at(doc, animation, 0.5).findSlot("lash_r")!.pose.getAttachment()?.name).toBe("lash");
    expect(validateSkeleton({ ...doc, animations: { blink: animation } }, { runtimeAnimations: ["blink"] }).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("puts blinks over the source's pose changes so the lids are shut as each head move starts", () => {
    const doc = face();
    expect(poseChanges(doc, "idle", ["head"]).map((c) => c.time)).toEqual([1, 2]);
    const { animation, notes } = blink(doc, { lids: [{ bone: "lid_l", closed: { y: -9 } }], onPoses: { source: "idle", bones: ["head"] } });
    expect(notes.join(" ")).toMatch(/2 pose change\(s\) in idle/);
    for (const t of [1, 2]) expect(at(doc, animation, t).findBone("lid_l")!.pose.y).toBeCloseTo(-9, 3);
    expect(at(doc, animation, 0.5).findBone("lid_l")!.pose.y).toBeCloseTo(0, 3);
    // fill: no gap between blinks longer than 1.2 s, the loop's wrap included.
    const filled = blink(doc, { lids: [{ bone: "lid_l", closed: { y: -9 } }], onPoses: { source: "idle", bones: ["head"] }, fill: 1.2 });
    const starts = filled.notes[0]!.match(/at ([^:]+):/)![1]!.split(", ").map((x) => parseFloat(x));
    const gaps = starts.map((s, i) => (i + 1 < starts.length ? starts[i + 1]! : starts[0]! + 3) - s);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(1.2 + 1e-6);
  });
});

describe("gaze: eye darts with a drift", () => {
  it("darts to each fixation in 0.1 s, drifts while resting and comes back at the loop end", () => {
    const doc = face();
    const fixations = [{ time: 0.5, x: 4, y: 0 }, { time: 1.5, x: -3, y: 1.5 }];
    const { animation } = gaze(doc, { bones: ["look"], fixations, duration: 3, drift: 0 });
    const setup = at(doc, {}, 0).findBone("look")!.appliedPose;
    const off = (t: number) => { const p = at(doc, animation, t).findBone("look")!.appliedPose; return [p.worldX - setup.worldX, p.worldY - setup.worldY]; };
    expect(off(0.5)).toEqual([expect.closeTo(0, 3), expect.closeTo(0, 3)]); // the dart starts here
    expect(off(0.6)).toEqual([expect.closeTo(4, 3), expect.closeTo(0, 3)]); // ...and lands 0.1 s later
    expect(off(0.55)[0]).toBeGreaterThan(2.2); // fast out (ease out): past half way at half time
    expect(off(1.6)).toEqual([expect.closeTo(-3, 3), expect.closeTo(1.5, 3)]);
    expect(off(3)).toEqual([expect.closeTo(0, 3), expect.closeTo(0, 3)]);
  });

  it("random fixations stay inside the radius, move a visible amount, and repeat for a seed", () => {
    const doc = face();
    const a = gaze(doc, { bones: ["look"], count: 6, duration: 4, seed: 7 }), b = gaze(doc, { bones: ["look"], count: 6, duration: 4, seed: 7 });
    expect(a.animation).toEqual(b.animation);
    const keys = a.animation.bones!.look!.translate!;
    const radius = 300 * 0.02;
    for (const k of keys) expect(Math.hypot(k.x as number, (k.y as number) / 0.6)).toBeLessThanOrEqual(radius * 1.13 + 1e-6); // radius + drift
    expect(keys[0]).toMatchObject({ x: 0, y: 0 });
    expect(keys[keys.length - 1]).toMatchObject({ time: 4, x: 0, y: 0 });
    expect(() => gaze(doc, { bones: ["nope"] })).toThrow(/Unknown bone/);
  });

  it("keeps a look control bone inside the range its clamped constraints follow, so the eyes never stop or diverge", () => {
    const doc = face();
    // Two pupils driven by "look", clamped differently (as eyes drawn at different depths): x 0..+16 / 0..+12, y -8..0 / -6..0.
    doc.bones.push({ name: "pupil_l", parent: "eye_l" } as never, { name: "pupil_r", parent: "eye_r" } as never);
    doc.constraints = [
      { type: "transform", name: "look_l", source: "look", bones: ["pupil_l"], localSource: true, localTarget: true, additive: true, clamp: true, properties: { x: { offset: 40, to: { x: { max: 8, scale: 0.5 } } }, y: { to: { y: { max: -4, scale: 0.5 } } } } },
      { type: "transform", name: "look_r", source: "look", bones: ["pupil_r"], localSource: true, localTarget: true, additive: true, clamp: true, properties: { x: { offset: 40, to: { x: { max: 6, scale: 0.5 } } }, y: { to: { y: { max: -3, scale: 0.5 } } } } },
    ] as never;
    const box = clampBox(loadSkeletonData(doc), "look")!;
    expect(box).toEqual({ x: [0, 12], y: [-6, 0], constraints: ["look_l", "look_r"] });
    const { animation, notes } = gaze(doc, { bones: ["look"], count: 8, duration: 6, seed: 2 });
    for (const k of animation.bones!.look!.translate!) {
      expect(k.x as number).toBeGreaterThanOrEqual(0); expect(k.x as number).toBeLessThanOrEqual(12);
      expect(k.y as number).toBeGreaterThanOrEqual(-6); expect(k.y as number).toBeLessThanOrEqual(0);
      expect(Math.abs((k.time ?? 0) * 30 - Math.round((k.time ?? 0) * 30))).toBeLessThan(1e-4);
    }
    expect(notes[1]).toMatch(/look drives clamped transform constraints \(look_l, look_r\): its offsets stay within x 0..12, y -6..0/);
    // A fixation asked for outside the range is pulled in.
    const pulled = gaze(doc, { bones: ["look"], fixations: [{ time: 1, x: 0, y: 50 }], duration: 3 });
    expect(pulled.notes[1]).toMatch(/1 fixation\(s\) pulled inside/);
  });
});

describe("validator: clamped constraints driven past their range, and keys too small to see", () => {
  it("flags an animation that pushes a look bone past its clamp, and a near-zero rotate key", () => {
    const doc = face();
    doc.bones.push({ name: "pupil_l", parent: "eye_l" } as never);
    doc.constraints = [{ type: "transform", name: "look_l", source: "look", bones: ["pupil_l"], localSource: true, localTarget: true, additive: true, clamp: true, properties: { x: { offset: 40, to: { x: { max: 8, scale: 0.5 } } } } }] as never;
    doc.animations = {
      // look moves 24 units right: the pupil can follow 16 (8 / 0.5), then stops 4 short.
      far: { bones: { look: { translate: [{ x: 0, y: 0 }, { time: 1, x: 24, y: 0 }] }, lid_l: { rotate: [{ value: 0 }, { time: 0.5, value: 0.04 }, { time: 1, value: 0 }] } } },
      near: { bones: { look: { translate: [{ x: 0, y: 0 }, { time: 1, x: 12, y: 0 }] } } },
    } as never;
    const issues = validateSkeleton(doc, {});
    const clamped = issues.filter((i) => i.code === "constraint-clamped");
    expect(clamped.map((i) => i.where)).toEqual(["animations/far"]);
    expect(clamped[0]!.message).toMatch(/drives look past the range of constraint look_l: pupil_l stops at its limit \(4 beyond it at 1s\)/);
    const dead = issues.filter((i) => i.code === "invisible-keys");
    expect(dead.map((i) => i.where)).toEqual(["animations/far"]);
    expect(dead[0]!.message).toMatch(/lid_l rotate \(0.04\)/);
  });
});

/** The face with a mouth: a smile mesh weighted to its corner bone, an "o" drawing on the mouth bone, under a jaw. */
function mouthFace(): SkeletonJson {
  const doc = face();
  doc.bones.push({ name: "jaw", parent: "head", x: -20 } as never, { name: "mouth", parent: "jaw" } as never, { name: "corner_l", parent: "mouth", x: 5 } as never);
  const corner = doc.bones.findIndex((b) => b.name === "corner_l");
  doc.slots!.push({ name: "mouth", bone: "mouth", attachment: "smile" });
  doc.skins![0]!.attachments!.mouth = {
    smile: { type: "mesh", uvs: [0, 0, 1, 0, 0, 1], triangles: [0, 1, 2], hull: 3, vertices: [1, corner, 0, 0, 1, 1, corner, 4, 0, 1, 1, corner, 0, 4, 1], width: 4, height: 4 },
    o: region(4, 4),
  } as never;
  return doc;
}

const lids = { lids: ["lid_l", "lid_r"], closedFrom: "shut@0" };

describe("face audit of existing animations", () => {
  it("flags head moves with the eyes open, and none once blink onPoses covers them (the blink on a track above)", () => {
    const doc = face();
    const alone = faceAudit(doc, { ...lids, animations: ["idle"], bones: ["head"] });
    expect(alone.animations[0]!.poseChanges.map((c) => [c.time, c.hidden])).toEqual([[1, false], [2, false]]);
    expect(alone.issues.map((i) => i.code)).toEqual(["face-open-pose-change"]);
    expect(alone.issues[0]!.message).toMatch(/at 1s \(frame 30, head\), 2s \(frame 60, head\) \(no blink in it\)/);
    // The reverse of onPoses: the blinks it places hide every move.
    const { animation } = blink(doc, { lids: [{ bone: "lid_l", closedFrom: "shut@0" }, { bone: "lid_r", closedFrom: "shut@0" }], hide: ["lash_l", "lash_r"], onPoses: { source: "idle", bones: ["head"] } });
    doc.animations!.blink = animation;
    const covered = faceAudit(doc, { ...lids, animations: ["idle"], bones: ["head"], blink: "blink" });
    expect(covered.animations[0]!.poseChanges.every((c) => c.hidden)).toBe(true);
    expect(covered.issues).toEqual([]);
    expect(covered.animations[0]!.blinks).toHaveLength(2);
    // Setup keys on the lids (what setupKeys adds for SkeletonMecanim) hold a pose, they do not blink: the track stays.
    doc.animations!.idle!.bones!.lid_l = { translate: [{ x: 0, y: 0 }] } as never;
    const keyed = faceAudit(doc, { ...lids, animations: ["idle"], bones: ["head"], blink: "blink" });
    expect(keyed.issues).toEqual([]);
    expect(keyed.notes.join(" ")).not.toMatch(/not over idle/);
  });

  it("keeps an animation's own blinks when a blink track is given (the track would replace them)", () => {
    const doc = face();
    // idle blinks itself over both head moves; the blink track blinks elsewhere (at 0.3 s).
    const own = blink(doc, { lids: [{ bone: "lid_l", closedFrom: "shut@0" }, { bone: "lid_r", closedFrom: "shut@0" }], hide: ["lash_l", "lash_r"], onPoses: { source: "idle", bones: ["head"] } }).animation;
    doc.animations!.idle = { ...doc.animations!.idle, bones: { ...doc.animations!.idle!.bones, ...own.bones }, slots: own.slots } as never;
    doc.animations!.track = blink(doc, { lids: [{ bone: "lid_l", closedFrom: "shut@0" }, { bone: "lid_r", closedFrom: "shut@0" }], hide: ["lash_l", "lash_r"], duration: 3, at: 0.3 }).animation;
    const r = faceAudit(doc, { ...lids, animations: ["idle"], bones: ["head"], blink: "track" });
    expect(r.issues).toEqual([]);
    expect(r.animations[0]!.blinks.map((b) => b.shut[0])).toEqual([1, 2]);
    expect(r.notes.join(" ")).toMatch(/not over idle, which shut the eyes with their own keys/);
  });

  it("flags a mouth drawing swap with the eyes open but not one behind a blink", () => {
    const doc = mouthFace();
    doc.animations!.talk = {
      bones: { lid_l: { translate: [{ x: 0, y: 0 }, { time: 0.9, x: 0, y: 0 }, { time: 1, x: 0, y: -9 }, { time: 1.1, x: 0, y: -9 }, { time: 1.2, x: 0, y: 0 }] } },
      slots: { mouth: { attachment: [{ time: 1, name: "o" }, { time: 2, name: "smile" }] } },
    } as never;
    const r = faceAudit(doc, { lids: ["lid_l"], closedFrom: "shut@0", animations: ["talk"] });
    expect(r.animations[0]!.mouthSwaps.map((s) => [s.time, s.from, s.to, s.hidden])).toEqual([[1, "smile", "o", true], [2, "o", "smile", false]]);
    const swap = r.issues.filter((i) => i.code === "face-open-mouth-swap");
    expect(swap).toHaveLength(1);
    expect(swap[0]!.message).toMatch(/at 2s \(mouth: o -> smile\)/);
  });

  it("flags lashes drawn while the lids are shut, and not when blink hides them", () => {
    const doc = face();
    const lidsShut = [{ bone: "lid_l", closedFrom: "shut@0" }, { bone: "lid_r", closedFrom: "shut@0" }];
    doc.animations!.bare = blink(doc, { lids: lidsShut, duration: 2, at: 1 }).animation;
    doc.animations!.hidden = blink(doc, { lids: lidsShut, duration: 2, at: 1, hide: ["lash_l", "lash_r"] }).animation;
    const r = faceAudit(doc, { ...lids, animations: ["bare", "hidden"] });
    expect(r.animations[0]!.visibleWhileShut.map((v) => v.slot)).toEqual(["lash_l", "lash_r"]);
    expect(r.animations[1]!.visibleWhileShut).toEqual([]);
    expect(r.issues.filter((i) => i.code === "face-visible-while-shut").map((i) => i.where)).toEqual(["animations/bare", "animations/bare"]);
    expect(r.notes.join(" ")).toMatch(/Checked while shut: lash_l, lash_r/); // lash slots found by name
  });

  it("flags lashes still hidden on an open eye (switch keyed on whole frames past the lids), not blink's own hide", () => {
    const doc = face();
    const lidsShut = [{ bone: "lid_l", closedFrom: "shut@0" }, { bone: "lid_r", closedFrom: "shut@0" }];
    doc.animations!.ok = blink(doc, { lids: lidsShut, duration: 2, at: 1, hide: ["lash_l", "lash_r"] }).animation;
    const clean = faceAudit(doc, { ...lids, animations: ["ok"] });
    expect(clean.animations[0]!.hiddenWhileOpen).toEqual([]);
    expect(clean.issues.filter((i) => i.code === "face-hidden-while-open")).toEqual([]);
    const end = clean.animations[0]!.blinks[0]!.end, start = clean.animations[0]!.blinks[0]!.start;
    const late = JSON.parse(JSON.stringify(doc.animations!.ok));
    for (const n of ["lash_l", "lash_r"]) {
      const keys = late.slots[n].attachment as { time?: number; name?: string }[];
      const off = keys.findIndex((k) => k.time !== undefined && k.name === undefined);
      keys[off]!.time = +(start - 1 / 30).toFixed(4);
      keys[off + 1]!.time = +(end + 2 / 30).toFixed(4);
    }
    doc.animations!.late = late;
    const r = faceAudit(doc, { ...lids, animations: ["late"] });
    const h = r.animations[0]!.hiddenWhileOpen;
    expect(new Set(h.map((x) => x.slot))).toEqual(new Set(["lash_l", "lash_r"]));
    expect(h.some((x) => x.to >= end - 1e-6)).toBe(true);
    expect(h.some((x) => x.from <= start + 1e-6)).toBe(true);
    expect(h.every((x) => x.closure <= 0.1)).toBe(true);
    expect(r.issues.filter((i) => i.code === "face-hidden-while-open").length).toBe(h.length);
    expect(r.issues.find((i) => i.code === "face-hidden-while-open")!.message).toMatch(/Key the switch on whole frames by a threshold/);
  });

  it("flags mouth bones left posed under another drawing, and says when they move the drawing on screen", () => {
    const doc = mouthFace();
    doc.animations!.swap = {
      slots: { mouth: { attachment: [{ time: 0.5, name: "o" }, { time: 1.5, name: "smile" }] } },
      // corner_l stays turned after the smile goes; the jaw opens for the "o" and closes in time; then the jaw stays open.
      bones: {
        corner_l: { rotate: [{ value: 0 }, { time: 0.4, value: 15 }, { time: 1.5, value: 15 }, { time: 1.6, value: 0 }] },
        jaw: { rotate: [{ time: 1.7, value: 0 }, { time: 1.8, value: 6 }, { time: 2, value: 6 }] },
      },
    } as never;
    doc.animations!.clean = {
      slots: { mouth: { attachment: [{ time: 0.5, name: "o" }, { time: 1.5, name: "smile" }] } },
      bones: { corner_l: { rotate: [{ value: 0 }, { time: 0.2, value: 15 }, { time: 0.5, value: 0, curve: "stepped" }, { time: 1.5, value: 0 }, { time: 1.7, value: 10 }] } },
    } as never;
    const groups = [{ slot: "mouth", attachment: "smile", bones: ["corner_l"] }, { slot: "mouth", attachment: "o", bones: ["jaw"] }];
    const r = faceAudit(doc, { ...lids, animations: ["swap", "clean"], mouthGroups: groups });
    const swap = r.animations[0]!.mouthGroups;
    expect(swap.map((g) => [g.bone, g.shown, g.from, g.to, g.deformsShown])).toEqual([["corner_l", "o", 0.5, 1.4958, false], ["jaw", "smile", 1.7042, 2, true]]);
    expect(swap[0]!.offset).toBe("rotate 15");
    expect(r.issues.filter((i) => i.code === "face-mouth-group-posed").map((i) => i.where)).toEqual(["animations/swap", "animations/swap"]);
    expect(r.issues.find((i) => i.message.includes("jaw"))!.message).toMatch(/it moves the drawing on screen, smile/);
    expect(r.animations[1]!.mouthGroups).toEqual([]);
  });

  it("reports blink timing in frames and flags a blink shut only between frames", () => {
    const doc = face();
    const lidsShut = [{ bone: "lid_l", closedFrom: "shut@0" }];
    doc.animations!.b = blink(doc, { lids: lidsShut, duration: 2, at: 1 }).animation;
    doc.animations!.slow = blink(doc, { lids: lidsShut, duration: 2, at: 0.5, closeTime: 3 / 30, holdTime: 4 / 30, openTime: 6 / 30 }).animation;
    // Shut from 1.04 s to 1.05 s: between frame 31 (1.0333) and 32 (1.0667) at 30 fps.
    doc.animations!.flash = { bones: { lid_l: { translate: [{ x: 0, y: 0 }, { time: 1, x: 0, y: 0 }, { time: 1.04, x: 0, y: -9 }, { time: 1.05, x: 0, y: -9 }, { time: 1.1, x: 0, y: 0 }] } } } as never;
    const r = faceAudit(doc, { lids: ["lid_l"], closedFrom: "shut@0", animations: ["b", "slow", "flash"] });
    const [b, slow, flash] = r.animations;
    expect(b!.blinks).toEqual([{ start: 1, shut: [1.0667, 1.1333], end: 1.2333, frames: { close: 2, closed: 2, open: 3 }, shutFrames: 3 }]);
    expect(slow!.blinks[0]!.frames).toEqual({ close: 3, closed: 4, open: 6 });
    expect(flash!.blinks[0]!.shutFrames).toBe(0);
    expect(r.issues.filter((i) => i.code === "face-blink-subframe").map((i) => i.where)).toEqual(["animations/flash"]);
    // Two blinks with the lids held half lowered between them (never back at rest) are two blinks, timed apart.
    const y = (t: number, v: number) => ({ time: t, x: 0, y: v });
    doc.animations!.drowsy = { bones: { lid_l: { translate: [{ x: 0, y: 0 }, y(0.5, 0), y(0.6, -9), y(0.7, -4.5), { ...y(1.5, -4.5) }, y(1.6, -9), y(1.7, -9), y(1.9, 0)] } } } as never;
    const dr = faceAudit(doc, { lids: ["lid_l"], closedFrom: "shut@0", animations: ["drowsy"] }).animations[0]!.blinks;
    expect(dr.map((x) => [x.start, x.shut, x.end, x.frames])).toEqual([[0.5, [0.6, 0.6], 0.7, { close: 3, closed: 0, open: 3 }], [1.5, [1.6, 1.7], 1.9, { close: 3, closed: 3, open: 6 }]]);
    // A lid that only half closes is a partial blink, not a blink.
    doc.animations!.squint = { bones: { lid_l: { translate: [{ x: 0, y: 0 }, { time: 0.5, x: 0, y: -4.5 }, { time: 1, x: 0, y: 0 }] } } } as never;
    const sq = faceAudit(doc, { lids: ["lid_l"], closedFrom: "shut@0", animations: ["squint"] });
    expect(sq.animations[0]!.blinks).toEqual([]);
    expect(sq.animations[0]!.partialBlinks).toEqual([{ time: 0.5, closure: 0.5 }]);
  });

  it("reads the eye state from eye slots, measures lids relative to the eye, and rejects unknown names", () => {
    const doc = mouthFace();
    doc.slots!.push({ name: "iris_l", bone: "eye_l", attachment: "iris" });
    doc.skins![0]!.attachments!.iris_l = { iris: region(3, 3) } as never;
    // The iris is hidden from 1 s to 1.1 s; meanwhile the whole eye darts (the lids ride along: not a blink).
    doc.animations!.look = {
      slots: { iris_l: { attachment: [{ time: 1 }, { time: 1.1, name: "iris" }] } },
      bones: { eye_l: { translate: [{ x: 0, y: 0 }, { time: 0.4, x: 0, y: 6 }] } },
    } as never;
    const r = faceAudit(doc, { lids: ["lid_l"], eyes: [{ slot: "iris_l" }], animations: ["look"] });
    expect(r.closedPose).toBe("none: the lids never move");
    expect(r.animations[0]!.blinks.map((b) => b.shut)).toEqual([[1, 1.1]]);
    expect(() => faceAudit(doc, { lids: ["nope"] })).toThrow(/Unknown bone: nope/);
    expect(() => faceAudit(doc, { lids: ["lid_l"], blink: "nope" })).toThrow(/Animation "nope" not found/);
  });

  it("audits two faces in one skeleton apart: one face's blink never reads the other's lashes as drawn while shut", () => {
    // Two characters share a skeleton. The fox blinks; the bird's lashes stay on (its eyes are open).
    const doc = {
      skeleton: { spine: "4.3.26", height: 300 },
      bones: [
        { name: "root" }, { name: "fox_head", parent: "root", y: 150, length: 60 }, { name: "bird_head", parent: "root", x: 200, y: 100, length: 40 },
        { name: "fox_lid", parent: "fox_head", x: 20 }, { name: "bird_lid", parent: "bird_head", x: 15 },
      ],
      slots: [{ name: "fox_lash", bone: "fox_lid", attachment: "lash" }, { name: "bird_lash", bone: "bird_lid", attachment: "lash" }],
      skins: [{ name: "default", attachments: { fox_lash: { lash: region() }, bird_lash: { lash: region() } } }],
      animations: {
        idle: {
          bones: { fox_lid: { translate: [{ x: 0, y: 0, curve: "stepped" }, { time: 1, x: 0, y: 0 }, { time: 1.05, x: 0, y: -9, curve: "stepped" }, { time: 1.15, x: 0, y: -9 }, { time: 1.2, x: 0, y: 0 }] } },
          slots: { fox_lash: { attachment: [{ time: 1 }, { time: 1.2, name: "lash" }] } },
        },
      },
    } as unknown as SkeletonJson;
    const base = { lids: ["fox_lid", "bird_lid"], hide: ["fox_lash", "bird_lash"], bones: ["fox_head", "bird_head"], animations: ["idle"] };
    const together = faceAudit(doc, base);
    expect(together.issues.map((i) => i.message).join(" ")).toMatch(/bird_lash/); // the false alarm
    const hint = together.notes.find((n) => n.includes("different heads"))!;
    const suggested = JSON.parse(hint.slice(hint.indexOf("faces: ") + 7, -1));
    expect(suggested.map((f: { name: string; hide: string[] }) => [f.name, f.hide])).toEqual([["fox_head", ["fox_lash"]], ["bird_head", ["bird_lash"]]]);
    const apart = faceAudit(doc, { animations: ["idle"], faces: suggested });
    expect(apart.issues.filter((i) => i.code === "face-visible-while-shut")).toEqual([]);
    expect(apart.animations.map((a) => [a.face, a.blinks.length])).toEqual([["fox_head", 1], ["bird_head", 0]]);
  });

  it("gives a hand-written face without bones only the heads above its own lids", () => {
    const doc = {
      skeleton: { spine: "4.3.26", height: 300 },
      bones: [
        { name: "root" }, { name: "fox_head", parent: "root", y: 150, length: 60 }, { name: "bird_head", parent: "root", x: 200, y: 100, length: 40 },
        { name: "fox_lid", parent: "fox_head", x: 20 }, { name: "bird_lid", parent: "bird_head", x: 15 },
      ],
      slots: [], skins: [{ name: "default", attachments: {} }],
      animations: { idle: { bones: { bird_head: { rotate: [{ value: 0, curve: "stepped" }, { time: 1, value: 0 }, { time: 1.1, value: 20 }] } } } },
    } as unknown as SkeletonJson;
    const r = faceAudit(doc, { animations: ["idle"], faces: [{ name: "fox", lids: ["fox_lid"] }, { name: "bird", lids: ["bird_lid"] }] });
    const changes = (f: string) => r.animations.find((a) => a.face === f)!.poseChanges.map((c) => c.bone);
    expect(changes("fox")).toEqual([]);
    expect(changes("bird")).toContain("bird_head");
  });

  it("reads eye bones under the head as one face, not one face per eye", () => {
    const r = faceAudit(face(), { lids: ["lid_l", "lid_r"], bones: ["head", "eye_l", "eye_r"], animations: ["idle"] });
    expect(r.notes.join(" ")).not.toMatch(/different heads/);
  });

  it("keeps an eye slot empty at setup an eye when the animations switch it to an open drawing", () => {
    const doc = mouthFace();
    doc.slots!.push({ name: "eye_slot", bone: "eye_l" });
    doc.skins![0]!.attachments!.eye_slot = { open: region(6, 3), closed: region(6, 1) } as never;
    // The eye is keyed on at 0 and hidden from 1 s to 1.1 s: hidden is shut here.
    doc.animations!.idle = { slots: { eye_slot: { attachment: [{ name: "open" }, { time: 1 }, { time: 1.1, name: "open" }] } } } as never;
    const r = faceAudit(doc, { eyes: [{ slot: "eye_slot", closed: ["closed"] }], animations: ["idle"] });
    expect(r.animations[0]!.blinks.map((b) => b.shut)).toEqual([[1, 1.1]]);
  });

  it("reads a lid drawn over the eye: a slot empty at setup is open while hidden, shut while it shows", () => {
    // A lid drawn over the eye: the eyelid slot shows nothing until a blink draws the shut lid over the eye.
    const doc = mouthFace();
    doc.slots!.push({ name: "shut_l", bone: "eye_l" });
    doc.skins![0]!.attachments!.shut_l = { shut_l: region(6, 3) } as never;
    doc.animations!.idle = { slots: { shut_l: { attachment: [{ time: 1, name: "shut_l" }, { time: 1.1 }] } } } as never;
    const r = faceAudit(doc, { eyes: [{ slot: "shut_l", closed: ["shut_l"] }], animations: ["idle"] });
    expect(r.animations[0]!.blinks.map((b) => b.shut)).toEqual([[1, 1.1]]);
    expect(r.notes[0]).toMatch(/empty at setup, a lid over the eye, so hidden is open/);
  });

  it("keeps hidden = shut for an eye slot empty at setup that also has an open eye drawing", () => {
    const doc = mouthFace();
    doc.slots!.push({ name: "eye_s", bone: "eye_l" });
    doc.skins![0]!.attachments!.eye_s = { eye_open: region(6, 3), eye_closed: region(6, 3) } as never;
    doc.animations!.idle = { slots: { eye_s: { attachment: [{ name: "eye_open" }, { time: 1 }, { time: 1.1, name: "eye_open" }] } } } as never;
    const r = faceAudit(doc, { eyes: [{ slot: "eye_s", closed: ["eye_closed"] }], animations: ["idle"] });
    expect(r.animations[0]!.blinks.map((b) => b.shut)).toEqual([[1, 1.1]]);
  });
});
