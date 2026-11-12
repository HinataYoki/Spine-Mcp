import { describe, expect, it } from "vitest";
import { animationDuration, summarizeSkeleton } from "../src/spine/inspect.js";
import { validateSkeleton } from "../src/spine/validate.js";
import { loadMini } from "./helpers.js";

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("summarizeSkeleton", () => {
  it("reports structure and animation stats", () => {
    const s = summarizeSkeleton("mini", loadMini());
    expect(s.counts).toMatchObject({ bones: 9, slots: 5, constraints: 2, animations: 3, events: 1 });
    expect(s.constraints).toEqual({ ik: ["arm-ik"], physics: ["tail-tip"] });
    expect(s.attachments).toEqual({ region: 5, mesh: 1 });
    expect(s.boneTree.split("\n")[0]).toBe("root");
    const idle = s.animations.find((a) => a.name === "idle")!;
    expect(idle.duration).toBe(2);
    expect(idle.timelines).toMatchObject({ "bone.translate": 1, "bone.rotate": 1, "slot.attachment": 1, ik: 1, events: 1 });
    expect(idle.curves.bezier).toBe(6);
  });

  it("computes duration from the last key", () => {
    expect(animationDuration(loadMini().animations!["bad-loop"]!)).toBe(1);
  });
});

describe("validateSkeleton", () => {
  it("passes the clean fixture without errors", () => {
    const issues = validateSkeleton(loadMini());
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("flags keys on physics-driven bones and seam pops on loops", () => {
    const issues = validateSkeleton(loadMini(), { loopAnimations: ["idle", "bad-loop"] });
    expect(codes(issues)).toContain("physics-bone-keyed");
    const seam = issues.find((i) => i.code === "loop-seam");
    expect(seam?.where).toBe("animations/bad-loop");
    expect(issues.some((i) => i.code === "loop-seam" && i.where === "animations/idle")).toBe(false);
  });

  it("catches references Spine would silently drop on import", () => {
    const doc = loadMini();
    doc.animations!.idle!.bones!["ghost"] = { rotate: [{ value: 5 }] };
    doc.animations!.idle!.slots!.eyes!.attachment!.push({ time: 1.5, name: "eyes-ghost" });
    const issues = validateSkeleton(doc, { runtime: false });
    expect(codes(issues)).toEqual(expect.arrayContaining(["missing-bone", "missing-attachment"]));
  });

  it("catches structural errors", () => {
    const doc = loadMini();
    doc.bones.push({ name: "orphan", parent: "nope" });
    doc.bones.push({ name: "hip", parent: "root" });
    doc.slots!.push({ name: "bad", bone: "missing" });
    doc.constraints!.push({ type: "ik", name: "x", bones: ["head"], target: "gone" });
    const mesh = doc.skins![0]!.attachments!.body!.body!;
    mesh.vertices![1] = 99; // weighted bone index out of range
    doc.animations!["bad-loop"]!.bones!.head!.rotate!.reverse();
    const c = codes(validateSkeleton(doc, { runtime: false }));
    expect(c).toEqual(expect.arrayContaining(["missing-bone", "duplicate-name", "weight-bone-index", "key-order"]));
  });

  it("allows the same constraint name across types but not within one type", () => {
    const doc = loadMini();
    doc.constraints!.push({ type: "transform", name: "tail-tip", bones: ["tail"], source: "hip" });
    expect(codes(validateSkeleton(doc, { runtime: false }))).not.toContain("duplicate-name");
    doc.constraints!.push({ type: "ik", name: "arm-ik", bones: ["head"], target: "hand-target" });
    expect(codes(validateSkeleton(doc, { runtime: false }))).toContain("duplicate-name");
  });

  it("checks curve shape per timeline channel count", () => {
    const doc = loadMini();
    doc.animations!.idle!.bones!.hip!.translate![0]!.curve = [0.3, 0, 0.6, 0];
    expect(codes(validateSkeleton(doc, { runtime: false }))).toContain("curve-shape");
  });
});

describe("validateSkeleton 4.3 format checks (review #8)", () => {
  it("checks linked mesh sources by `source`, `slot` and `skin`", () => {
    const doc = loadMini();
    const atts = doc.skins![0]!.attachments!;
    atts.body!["body-linked"] = { type: "linkedmesh", source: "body", width: 40, height: 70 };
    expect(validateSkeleton(doc, { runtime: false }).filter((i) => i.severity === "error")).toEqual([]);
    atts.body!["bad-source"] = { type: "linkedmesh", source: "nope", width: 1, height: 1 };
    atts.body!["bad-skin"] = { type: "linkedmesh", source: "body", skin: "ghost", width: 1, height: 1 };
    atts.body!["not-mesh"] = { type: "linkedmesh", source: "head", slot: "head", width: 1, height: 1 };
    const c = codes(validateSkeleton(doc, { runtime: false }));
    expect(c).toEqual(expect.arrayContaining(["missing-attachment", "missing-skin", "linked-mesh-source"]));
  });

  it("checks skin constraint lists per type", () => {
    const doc = loadMini();
    doc.skins![0]!.ik = ["arm-ik"];
    expect(codes(validateSkeleton(doc, { runtime: false }))).not.toContain("missing-constraint");
    doc.skins![0]!.physics = ["arm-ik"]; // exists as ik, not physics
    expect(codes(validateSkeleton(doc, { runtime: false }))).toContain("missing-constraint");
  });

  it("checks attachment timelines and draw order slot references", () => {
    const doc = loadMini();
    doc.animations!.idle!.attachments = { default: { body: { ghost: { deform: [{ vertices: [0, 0] }] } } } } as never;
    doc.animations!.idle!.drawOrder = [{ offsets: [{ slot: "nope", offset: 1 }] }] as never;
    const c = codes(validateSkeleton(doc, { runtime: false }));
    expect(c.filter((x) => x === "missing-attachment").length).toBeGreaterThan(0);
    expect(c).toContain("missing-slot");
  });

  it("ignores loop words inside other words (legend, pendulum)", () => {
    const doc = loadMini();
    doc.animations!["legend-idle"] = structuredClone(doc.animations!["bad-loop"]!);
    doc.animations!["idle-end"] = structuredClone(doc.animations!["bad-loop"]!);
    const seams = validateSkeleton(doc).filter((i) => i.code === "loop-seam").map((i) => i.where);
    expect(seams).toContain("animations/legend-idle");
    expect(seams).not.toContain("animations/idle-end");
  });
});

describe("slot folders (4.3 slot names may contain '/')", () => {
  it("validates attachment timelines on slots whose names contain a slash", () => {
    const doc = loadMini();
    doc.slots!.push({ name: "fx/shine", bone: "head", attachment: "shine" });
    doc.skins![0]!.attachments!["fx/shine"] = { shine: { type: "mesh", uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2], vertices: [0, 0, 10, 0, 10, 10], hull: 3, width: 10, height: 10 } };
    doc.animations!.idle!.attachments = { default: { "fx/shine": { shine: { deform: [{ vertices: [0, 0] }, { time: 1 }] } } } } as never;
    expect(validateSkeleton(doc, { runtime: false }).filter((i) => i.severity === "error")).toEqual([]);
  });
});
