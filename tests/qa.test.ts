import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { findSkeletonFiles } from "../src/spine/audit.js";
import { animationDuration } from "../src/spine/inspect.js";
import { blink, breathe, suggest } from "../src/spine/generate.js";
import { rigQa } from "../src/spine/rigqa.js";
import { loadSkeletonData } from "../src/spine/runtime.js";
import { skinReport } from "../src/spine/skins.js";
import type { SkeletonJson } from "../src/spine/types.js";
import { validateSkeleton } from "../src/spine/validate.js";

const region = (w = 20, h = 20) => ({ width: w, height: h });
const UV = [0, 0, 1, 0, 1, 1, 0, 1];
// 4 vertices; vertex 0 has 5 influences and weights summing to 0.9, vertex 1 has a 0.5% weight.
const badWeights = [
  5, 0, 0, 0, 0.2, 1, 0, 0, 0.2, 2, 0, 0, 0.2, 3, 0, 0, 0.2, 4, 0, 0, 0.1,
  2, 1, 10, 0, 0.995, 2, 10, 0, 0.005,
  1, 1, 10, 10, 1,
  1, 1, 0, 10, 1,
];

function rig(): SkeletonJson {
  return {
    skeleton: { spine: "4.3.26", height: 200, images: "./images/" },
    bones: [
      { name: "root" }, { name: "torso", parent: "root", length: 50 }, { name: "head", parent: "torso", y: 50 },
      { name: "bone2", parent: "root" }, { name: "Head", parent: "torso" }, { name: "arm_L", parent: "torso" }, { name: "leftLeg", parent: "root" },
      { name: "eyelid", parent: "head" }, { name: "flipped", parent: "root", scaleX: -1, length: 5 },
    ],
    slots: [
      { name: "torso", bone: "torso", attachment: "torso" },
      { name: "eye", bone: "head", attachment: "eye-open" },
      { name: "skin ", bone: "torso", attachment: "mesh" },
      { name: "empty", bone: "flipped" },
    ],
    skins: [{
      name: "default",
      attachments: {
        torso: { torso: region(), spare: region() },
        eye: { "eye-open": region(), "eye-closed": region(), "eye-half": region() },
        "skin ": { mesh: { type: "mesh", uvs: UV, triangles: [0, 1, 2, 2, 3, 0], hull: 4, vertices: badWeights, width: 10, height: 10 } },
      },
    }],
    events: { step: {}, unused: {} },
    animations: { idle: { bones: { head: { rotate: [{ value: 0 }, { time: 1, value: 5 }] } }, events: [{ time: 0.5, name: "step" }] } },
  };
}

describe("rig QA", () => {
  it("finds naming, unused parts, weights and setup problems", () => {
    const r = rigQa(rig());
    const by = Object.fromEntries(r.findings.map((f) => [f.code, f]));
    expect(by["name-whitespace"]!.items).toEqual(['slot "skin "']);
    expect(by["name-case-clash"]!.items).toEqual(["head / Head"]);
    expect(by["default-bone-name"]!.items).toEqual(["bone2"]);
    expect(by["side-naming-mixed"]).toBeDefined();
    // bone2 and Head carry mesh weights, so they count as used.
    expect(by["unused-bone"]!.items).toEqual(["arm_L", "leftLeg", "eyelid"]);
    expect(by["attachment-never-shown"]!.items).toEqual(["default/torso/spare", "default/eye/eye-closed", "default/eye/eye-half"]);
    expect(by["empty-slot"]!.items).toEqual(["empty"]);
    expect(by["unused-event"]!.items).toEqual(["unused"]);
    expect(by["negative-scale-bone"]!.items).toEqual(["flipped"]);
    expect(by["weights-not-normalized"]!.items).toEqual(["default/skin /mesh: 1 vertex(es)"]);
    expect(by["too-many-influences"]!.items![0]).toContain("up to 5 bones");
    expect(by["tiny-weights"]!.items).toEqual(["default/skin /mesh: 1 weight(s)"]);
    expect(r.counts).toMatchObject({ meshes: 1, weightedMeshes: 1, attachments: 6 });
    // One separator style and one case in the fixture's images: none of the image-name findings.
    expect(r.findings.map((f) => f.code).filter((c) => c.startsWith("image-name"))).toEqual([]);
  });

  it("flags spaces and mixed styles in image names, as a game's atlases had them", () => {
    const doc = rig();
    const att = (doc.skins![0]!.attachments as Record<string, Record<string, unknown>>).torso!;
    for (const n of ["Hero_Arm_L", "Hero_Arm_R", "Fox-eyebrow-L", "Hero and Fox shadow", "drop1"]) att[n] = { ...(att.torso as object), path: n };
    const by = Object.fromEntries(rigQa(doc).findings.map((f) => [f.code, f]));
    expect(by["image-name-spaces"]!.items).toEqual(['"Hero and Fox shadow"']);
    expect(by["image-name-style-mixed"]!.message).toMatch(/2 with "_", 4 with "-" \(e\.g\. Hero_Arm_L, Fox-eyebrow-L\)/);
    // Capitalised: Hero_Arm_L, Hero_Arm_R, Fox-eyebrow-L, Hero…; lowercase: the fixture's 6 plus drop1.
    expect(by["image-name-case-mixed"]!.message).toMatch(/\(4 vs 7\); lowercase: torso, spare, drop1/);
  });

  it("reads side tags as sides, not as capitals, and counts a name with both separators once", () => {
    const doc = rig();
    const att = (doc.skins![0]!.attachments as Record<string, Record<string, unknown>>).torso!;
    for (const n of ["L_hand", "R_hand", "arm_L-01", "arm_R-01"]) att[n] = { ...(att.torso as object), path: n };
    const by = Object.fromEntries(rigQa(doc).findings.map((f) => [f.code, f]));
    expect(by["image-name-case-mixed"]).toBeUndefined();
    expect(by["image-name-style-mixed"]!.message).toMatch(/2 with "_", \d+ with "-", 2 with both/);
  });

  it("checks image files against attachments, sharing images across skeletons", () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-qa-"));
    mkdirSync(join(dir, "images", "eyes"), { recursive: true });
    for (const f of ["torso.png", "spare.png", "mesh.png", "eye-open.png", "other.png", "stray.png"]) writeFileSync(join(dir, "images", f), "");
    const doc = rig();
    doc.skins![0]!.attachments!.eye = { "eye-open": region(), "eye-closed": { ...region(), path: "eyes/closed" } };
    const other: SkeletonJson = { skeleton: {}, bones: [{ name: "root" }], slots: [{ name: "s", bone: "root" }], skins: [{ name: "default", attachments: { s: { other: region() } } }] };
    const by = Object.fromEntries(rigQa(doc, { baseDir: dir, otherSkeletons: [other] }).findings.map((f) => [f.code, f]));
    expect(by["image-missing"]!.items).toEqual(["eyes/closed (default/eye/eye-closed)"]);
    expect(by["image-unused"]!.items).toEqual(["stray.png"]);
    expect(by["image-missing"]!.severity).toBe("warning");
  });

  it("counts linked meshes: their images and their source meshes", () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-qa-linked-"));
    mkdirSync(join(dir, "images"), { recursive: true });
    for (const f of ["body.png", "body-red.png"]) writeFileSync(join(dir, "images", f), "");
    const doc: SkeletonJson = {
      skeleton: { images: "./images/" }, bones: [{ name: "root" }],
      slots: [{ name: "body", bone: "root", attachment: "body-red" }],
      skins: [{ name: "default", attachments: { body: {
        body: { type: "mesh", uvs: UV, triangles: [0, 1, 2], hull: 4, vertices: [0, 0, 1, 0, 1, 1, 0, 1], width: 1, height: 1 },
        "body-red": { type: "linkedmesh", source: "body", width: 1, height: 1 },
        "body-blue": { type: "linkedmesh", source: "body", width: 1, height: 1 },
      } } }],
    };
    const by = Object.fromEntries(rigQa(doc, { baseDir: dir }).findings.map((f) => [f.code, f]));
    expect(by["image-missing"]!.items).toEqual(["body-blue (default/body/body-blue)"]);
    expect(by["image-unused"]).toBeUndefined();
    // body is the source of a shown linked mesh, so it is not "never shown".
    expect(by["attachment-never-shown"]!.items).toEqual(["default/body/body-blue"]);
  });

  it("says nothing about a clean rig", () => {
    const clean: SkeletonJson = { skeleton: {}, bones: [{ name: "root" }, { name: "body", parent: "root" }], slots: [{ name: "body", bone: "body", attachment: "body" }], skins: [{ name: "default", attachments: { body: { body: region() } } }] };
    expect(rigQa(clean).findings).toEqual([]);
  });
});

describe("skins", () => {
  const doc: SkeletonJson = {
    skeleton: { spine: "4.3.26" },
    bones: [{ name: "root" }],
    slots: [{ name: "body", bone: "root", attachment: "body" }, { name: "hat", bone: "root", attachment: "hat" }, { name: "cape", bone: "root", attachment: "cape" }],
    skins: [
      { name: "default" },
      { name: "base", attachments: { body: { body: region(10, 10) }, hat: { hat: region(5, 5) } } },
      { name: "knight", attachments: { body: { body: region(30, 30) } } },
      { name: "wizard", attachments: { hat: { hat: region(8, 8) }, cape: { cape: region(20, 40) } } },
    ],
    animations: {},
  };

  it("reports each skin alone by default", () => {
    const r = skinReport(doc, loadSkeletonData(doc), { pagesKnown: false });
    expect(r.rows.map((x) => x.skins)).toEqual([["base"], ["knight"], ["wizard"]]);
    expect(r.rows[0]!.setup.visibleAttachments).toBe(2);
    expect(r.rows[1]!.emptySetupSlots).toEqual(["hat", "cape"]);
  });

  it("combines skins in order: conflicts, empty slots and budget", () => {
    const r = skinReport(doc, loadSkeletonData(doc), { pagesKnown: false, combinations: [["base", "knight", "wizard"], ["base", "knight"]], limits: { vertices: 8 } });
    const [all, two] = r.rows;
    expect(all!.conflicts).toEqual([{ slot: "body", placeholder: "body", skins: ["base", "knight"], wins: "knight" }, { slot: "hat", placeholder: "hat", skins: ["base", "wizard"], wins: "wizard" }]);
    expect(all!.emptySetupSlots).toEqual([]);
    expect(all!.setup.visibleAttachments).toBe(3);
    expect(all!.worst.vertices).toBe(12);
    expect(all!.overBudget[0]).toContain("vertices 12 > 8");
    expect(two!.emptySetupSlots).toEqual(["cape"]);
    expect(r.heaviest!.skins).toEqual(["base", "knight", "wizard"]);
    expect(r.findings.join(" ")).toContain("last skin listed wins");
    expect(() => skinReport(doc, loadSkeletonData(doc), { pagesKnown: false, combinations: [["nope"]] })).toThrow(/not found/);
    // Only a default skin: it is reported on its own.
    const plain: SkeletonJson = { skeleton: {}, bones: [{ name: "root" }], slots: [{ name: "a", bone: "root", attachment: "a" }], skins: [{ name: "default", attachments: { a: { a: region() } } }] };
    expect(skinReport(plain, loadSkeletonData(plain), { pagesKnown: false }).rows.map((x) => x.skins)).toEqual([["default"]]);
  });
});

describe("audit file discovery", () => {
  it("takes projects and standalone skeleton JSON, skips exports and staging copies", () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-audit-"));
    const skel = JSON.stringify({ skeleton: { spine: "4.3.26" }, bones: [{ name: "root" }] });
    mkdirSync(join(dir, "hero", "export"), { recursive: true });
    mkdirSync(join(dir, "loose"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "hero", "hero.spine"), "");
    writeFileSync(join(dir, "hero", "hero-mcp-staging.spine"), "");
    writeFileSync(join(dir, "hero", "export", "hero.json"), skel);
    writeFileSync(join(dir, "loose", "slime.json"), skel);
    writeFileSync(join(dir, "loose", "package.json"), '{"name":"x"}');
    writeFileSync(join(dir, "node_modules", "x", "a.spine"), "");
    expect(findSkeletonFiles(dir).files.map((f) => f.slice(dir.length + 1).split(sep).join("/"))).toEqual(["hero/hero.spine", "loose/slime.json"]);
    // Audited on its own, an export folder's JSON counts (its parent is outside the audit).
    expect(findSkeletonFiles(join(dir, "hero", "export")).files.map((f) => f.slice(dir.length + 1).split(sep).join("/"))).toEqual(["hero/export/hero.json"]);
    expect(findSkeletonFiles(dir, 1)).toMatchObject({ truncated: true });
    let deep = join(dir, "deep");
    for (let i = 0; i < 14; i++) deep = join(deep, `d${i}`);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, "far.json"), skel);
    expect(findSkeletonFiles(join(dir, "deep")).truncated).toBe(true);
  });
});

describe("generators", () => {
  const doc = rig();

  it("breathe loops seamlessly, followers lag and the result validates", () => {
    const { animation, notes } = breathe(doc, { torso: ["torso"], followers: ["head"], period: 2, rotate: 2 });
    // Torso children that do not follow the breath keep their size; the follower grows with the chest.
    expect(notes.join(" ")).toContain("Kept out of the breath (counter-scaled, and held in place when below the torso): Head, arm_L");
    expect(notes.join(" ")).toContain("Followers on the torso inherit its scale (head)");
    expect(animation.bones!.arm_L!.scale).toBeDefined();
    expect(animationDuration(animation)).toBe(2);
    const scale = animation.bones!.torso!.scale!;
    expect(scale[0]).toMatchObject({ x: 1, y: 1 });
    expect(scale.find((k) => k.time === 1)).toMatchObject({ y: 1.03 });
    expect(scale.at(-1)).toMatchObject({ time: 2, x: 1, y: 1 });
    const head = animation.bones!.head!.translate!;
    const peak = head.reduce((a, k) => ((k.y ?? 0) > (a.y ?? 0) ? k : a));
    expect(peak.time).toBeCloseTo(1 + 5 / 30, 5);
    expect(peak.y).toBe(1);
    expect(head[0]!.y).toBeCloseTo(head.at(-1)!.y!, 6);
    const d = { ...doc, animations: { breathe: animation } };
    const issues = validateSkeleton(d, { loopAnimations: ["breathe"], runtimeAnimations: ["breathe"] }).filter((i) => i.severity !== "info");
    expect(issues).toEqual([]);
    expect(() => breathe(doc, { torso: ["nope"] })).toThrow(/Unknown bone/);
  });

  it("blinks a lid drawn over the eye: a slot empty while open gets keys without a name, never an empty one", () => {
    // A lid drawn over the eye: the eyelid slot is empty in the setup pose and shows the shut lid during a blink.
    const { animation } = blink(doc, { eyes: [{ slot: "eye", open: "", closed: "eye-closed" }], duration: 2, at: 1 });
    const att = animation.slots!.eye!.attachment!;
    expect(att.every((k) => k.name !== "")).toBe(true);
    expect(att.map((k) => k.name ?? null)).toEqual([null, "eye-closed", null, null]);
    expect(validateSkeleton({ ...doc, animations: { blink: animation } }).filter((i) => i.severity === "error")).toEqual([]);
    // An empty name is what Spine's import changes: the validator says so before the write.
    const bad = { ...doc, animations: { b: { slots: { eye: { attachment: [{ name: "" }, { time: 0.5, name: "eye-closed" }] } } } } };
    expect(validateSkeleton(bad).map((i) => i.code)).toContain("empty-attachment-name");
  });

  it("blink swaps attachments and squashes lids inside the loop", () => {
    const { animation } = blink(doc, { eyes: [{ slot: "eye", open: "eye-open", closed: "eye-closed", half: "eye-half" }], lids: [{ bone: "eyelid" }], duration: 2, at: 1, double: true });
    const att = animation.slots!.eye!.attachment!;
    expect(att.map((k) => k.name)).toEqual(["eye-open", "eye-half", "eye-closed", "eye-half", "eye-open", "eye-half", "eye-closed", "eye-half", "eye-open"]);
    expect(animationDuration(animation)).toBe(2);
    const lid = animation.bones!.eyelid!.scale!;
    expect(Math.min(...lid.map((k) => k.y ?? 1))).toBeCloseTo(0.1, 6);
    const d = { ...doc, animations: { blink: animation } };
    expect(validateSkeleton(d, { runtimeAnimations: ["blink"] }).filter((i) => i.severity === "error")).toEqual([]);
    expect(() => blink(doc, { eyes: [{ slot: "eye", open: "eye-open", closed: "eye-closed" }], duration: 1, at: 0.95 })).toThrow(/does not fit/);
    expect(() => blink(doc, {})).toThrow(/needs eyes/);
    // A blink at 0 or ending exactly at the loop end never leaves two keys at one time.
    for (const opt of [{ at: 0 }, { at: 2.78 }]) { // 2.78 + 0.22 s (shut 0.07, held 0.05, open 0.1) ends on 3
      const a = blink(doc, { eyes: [{ slot: "eye", open: "eye-open", closed: "eye-closed" }], lids: [{ bone: "eyelid" }], duration: 3, ...opt }).animation;
      for (const keys of [a.slots!.eye!.attachment!, a.bones!.eyelid!.scale!]) {
        const times = keys.map((k) => k.time ?? 0);
        expect(new Set(times).size).toBe(times.length);
      }
    }
  });

  it("suggests candidates by name without choosing", () => {
    const s = suggest(doc);
    expect(s.torso).toEqual(["torso"]);
    expect(s.followers).toEqual(["head", "Head"]);
    expect(s.eyes).toEqual([{ slot: "eye", open: "eye-open", closed: "eye-closed", half: "eye-half" }]);
    expect(s.lids).toEqual(["eyelid"]);
  });
});

describe("blocking", () => {
  it("steps every curve and can keep only the key poses", async () => {
    const { deriveAnimationWithNotes } = await import("../src/spine/derive.js");
    const anim = {
      bones: {
        a: { rotate: [{ value: 0, curve: [0.1, 0, 0.2, 10] }, { time: 0.3, value: 10 }, { time: 0.5, value: 5 }, { time: 1, value: 0 }] },
        b: { rotate: [{ value: 0 }, { time: 0.5, value: 20 }, { time: 0.7, value: 15 }, { time: 1, value: 0 }], translate: [{ x: 0, y: 0 }, { time: 0.5, x: 3, y: 0 }, { time: 1, x: 0, y: 0 }] },
      },
      events: [{ time: 0.5, name: "step" }],
    };
    const view = deriveAnimationWithNotes(anim as never, [{ op: "blocking" }]).animation;
    expect(view.bones!.a!.rotate!.every((k) => k.curve === "stepped")).toBe(true);
    expect(view.bones!.a!.rotate!.map((k) => k.time ?? 0)).toEqual([0, 0.3, 0.5, 1]);
    expect(view.events![0]!.curve).toBeUndefined();
    const poses = deriveAnimationWithNotes(anim as never, [{ op: "blocking", keyPosesOnly: true, minTimelines: 3 }]);
    // 0, 0.5 and 1 are keyed by all three timelines; 0.3 and 0.7 are breakdowns.
    expect(poses.animation.bones!.a!.rotate!.map((k) => k.time ?? 0)).toEqual([0, 0.5, 1]);
    expect(poses.animation.bones!.b!.rotate!.map((k) => k.time ?? 0)).toEqual([0, 0.5, 1]);
    expect(poses.notes.join(" ")).toContain("3 key pose(s) kept");
    // Back to a spline for the next pass.
    const spline = deriveAnimationWithNotes(poses.animation, [{ op: "ease", easing: "easeInOut" }]).animation;
    expect(Array.isArray(spline.bones!.a!.rotate![0]!.curve)).toBe(true);
  });
});
