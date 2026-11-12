import { describe, expect, it } from "vitest";
import { compareAnimationAcrossDocs, exportsEqual } from "../src/spine/compare.js";
import { loadMini } from "./helpers.js";

describe("compareAnimationAcrossDocs", () => {
  it("treats a constant segment as equal whether linear or stepped (Spine's export normalization)", () => {
    const a = loadMini(), b = loadMini();
    a.animations!.hold = { bones: { head: { rotate: [{ value: 5 }, { time: 1, value: 5 }] } } };
    b.animations!.hold = { bones: { head: { rotate: [{ value: 5, curve: "stepped" }, { time: 1, value: 5 }] } } };
    expect(compareAnimationAcrossDocs(a, b, "hold")).toEqual({ equal: true, differences: [] });
  });

  it("treats a redundant key in a hold as equal (Spine drops it on export), by behaviour", () => {
    const a = loadMini(), b = loadMini();
    a.animations!.fade = { bones: { head: { rotate: [{ value: 0, curve: "stepped" }, { time: 1, value: 0 }, { time: 1.5, value: 0 }, { time: 2, value: 10 }] } } };
    b.animations!.fade = { bones: { head: { rotate: [{ value: 0, curve: "stepped" }, { time: 1.5, value: 0 }, { time: 2, value: 10 }] } } };
    expect(compareAnimationAcrossDocs(a, b, "fade").equal).toBe(true);
    b.animations!.fade!.bones!.head!.rotate![1]!.time = 1.2;
    expect(compareAnimationAcrossDocs(a, b, "fade").equal).toBe(false);
  });

  it("ignores omitted defaults and int/float notation", () => {
    const a = loadMini(), b = loadMini();
    a.animations!.x = { bones: { head: { rotate: [{ time: 0, value: 0 }, { time: 1, value: 10.0 }] } } };
    b.animations!.x = { bones: { head: { rotate: [{}, { time: 1, value: 10 }] } } };
    expect(compareAnimationAcrossDocs(a, b, "x").equal).toBe(true);
  });

  it("detects a real curve change", () => {
    const a = loadMini(), b = loadMini();
    b.animations!.idle!.bones!.head!.rotate![0]!.curve = [0.1, 0, 0.2, 6];
    const d = compareAnimationAcrossDocs(a, b, "idle");
    expect(d.equal).toBe(false);
    expect(d.differences.some((x) => x.includes("curves differ"))).toBe(true);
  });

  it("detects value, timing and attachment changes", () => {
    const base = loadMini();
    const value = loadMini();
    value.animations!.idle!.bones!.head!.rotate![1]!.value = 7;
    const timing = loadMini();
    timing.animations!.idle!.bones!.head!.rotate![1]!.time = 1.1;
    const att = loadMini();
    att.animations!.idle!.slots!.eyes!.attachment![0]!.name = "eyes-open";
    for (const doc of [value, timing, att]) expect(compareAnimationAcrossDocs(base, doc, "idle").equal).toBe(false);
  });
});

describe("exportsEqual", () => {
  it("ignores animations and the skeleton hash", () => {
    const a = loadMini(), b = loadMini();
    b.skeleton.hash = "different";
    b.animations = {};
    expect(exportsEqual(a, b)).toEqual([]);
    b.bones[1]!.y = 61;
    expect(exportsEqual(a, b)).toEqual(["bones"]);
  });
});

describe("deform timelines across separately loaded skeletons", () => {
  it("matches deform keys by attachment name, not the runtime attachment id", () => {
    const deform = { attachments: { default: { body: { body: { deform: [{ vertices: [0, 0, 2, 1] }, { time: 1, offset: 2, vertices: [1, -1] }] } } } } };
    const a = loadMini(), b = loadMini();
    a.animations!.d = structuredClone(deform) as never;
    b.animations!.d = structuredClone(deform) as never;
    expect(compareAnimationAcrossDocs(a, b, "d")).toEqual({ equal: true, differences: [] });
    (b.animations!.d as typeof deform).attachments.default.body.body.deform[1]!.vertices = [3, -1];
    expect(compareAnimationAcrossDocs(a, b, "d").equal).toBe(false);
  });
});
