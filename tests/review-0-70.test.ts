import { describe, expect, it } from "vitest";
import { buildRig, suggestRig, type Part } from "../src/spine/autorig.js";
import { withProfile, type Config } from "../src/config.js";
import { PRESETS } from "../src/spine/export.js";
import { lookAt, sway } from "../src/spine/generate.js";
import { rescaleStretchedRegions, stretchedRegions } from "../src/spine/intake.js";
import { rigParts, type LoadedPart } from "../src/spine/parts.js";
import { applyRigEdits } from "../src/spine/rigedit.js";
import { fitBezier, tidyAnimation } from "../src/spine/tidy.js";
import type { SkeletonJson } from "../src/spine/types.js";

const blob = (name: string, left: number, top: number, width: number, height: number, extra: Partial<Part> = {}): Part => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (((x - width / 2) / (width / 2)) ** 2 + ((y - height / 2) / (height / 2)) ** 2 <= 1) data.set([200, 120, 80, 255], (y * width + x) * 4);
  return { name, path: name, left, top, width, height, data, opacity: 1, ...extra };
};
const loaded = (name: string, extra: Partial<LoadedPart>): LoadedPart => {
  const b = blob(name, 0, 0, 8, 8);
  return { name, file: `${name}.png`, left: 0, top: 0, width: 8, height: 8, data: b.data, opacity: 1, hidden: false, ...extra } as unknown as LoadedPart;
};
const chain: SkeletonJson = { skeleton: { spine: "4.3.26", fps: 30 }, bones: [{ name: "root" }, { name: "a", parent: "root" }, { name: "b", parent: "a" }, { name: "c", parent: "b" }], slots: [], skins: [{ name: "default", attachments: {} }] } as SkeletonJson;

describe("review of 0.57-0.70", () => {
  it("keeps every event at a shared time or frame: each one fires", () => {
    const { animation } = tidyAnimation({ events: [{ time: 0.5, name: "a" }, { time: 0.5, name: "b" }, { time: 0.8, name: "c" }, { time: 0.81, name: "d" }] }, 30);
    expect((animation.events as { name: string }[]).map((e) => e.name)).toEqual(["a", "b", "c", "d"]);
  });

  it("gives a looping spin the spin's slope at the seam", () => {
    const times = Array.from({ length: 31 }, (_, i) => i / 30), values = times.map((t) => t * 360);
    const fit = fitBezier(times, [{ values, tol: 0.5 }], { loop: true });
    const first = fit.curves[0]!, last = fit.curves.at(-1)!;
    const startSlope = (first[1]! - values[0]!) / first[0]!, endSlope = (values[30]! - last[3]!) / (1 - last[2]!);
    expect(startSlope).toBeCloseTo(360, 0);
    expect(endSlope).toBeCloseTo(360, 0);
  });

  it("does not let a hidden lid take the slot of the drawing shown at setup", () => {
    const parts = [loaded("eyelid", { hidden: true, slot: "eye" }), loaded("eye_open", { slot: "eye" }), loaded("eye_look", { slot: "eye" })];
    expect(rigParts(parts, 1).map((p) => [p.name, !!p.shut])).toEqual([["eyelid", true], ["eye_open", false]]);
  });

  it("lets an explicit preset beat a profile default for what the preset sets", () => {
    const config = { profile: { name: "team", file: "/team.json", tools: { spine_export: { format: "binary", atlasName: "team" } } } } as unknown as Config;
    const { args, defaults } = withProfile(config, "spine_export", { preset: "web" }, Object.keys(PRESETS.web));
    expect(args).toEqual({ preset: "web", atlasName: "team" });
    expect(defaults).toEqual(["atlasName"]);
  });

  it("finds a region's image by path, then name, then its key", () => {
    const doc = { skeleton: { spine: "4.3.26" }, bones: [{ name: "root" }], slots: [{ name: "s", bone: "root" }], skins: [{ name: "default", attachments: { s: { head: { name: "head-red", width: 100, height: 100 } } } }] } as unknown as SkeletonJson;
    const sizes: Record<string, number> = { head: 50, "head-red": 100 };
    const images = (n: string) => (sizes[n] ? { width: sizes[n]!, height: sizes[n]! } : null);
    expect(stretchedRegions(doc, images)).toEqual([]);
    expect(rescaleStretchedRegions(doc, images)).toEqual([]);
  });

  it("traces a named region from its own image and keeps the name", () => {
    const rig = buildRig([blob("Body", 0, 0, 80, 80)], { bones: [{ name: "Body", joint: [40, 70], tip: [40, 10], layers: ["Body"] }], mesh: "none", scale: 1 }).doc;
    const att = (rig.skins![0]!.attachments as Record<string, Record<string, Record<string, unknown>>>).Body!.Body!;
    att.name = "Body-red";
    const asked: string[] = [];
    const img = blob("x", 0, 0, 80, 80);
    const out = applyRigEdits(rig, [{ op: "meshRegion", slot: "Body" }], { image: (p: string) => { asked.push(p); return { width: 80, height: 80, data: img.data }; } });
    expect(asked).toEqual(["Body-red"]);
    expect(((out.doc.skins![0]!.attachments as Record<string, Record<string, Record<string, unknown>>>).Body!.Body!).name).toBe("Body-red");
  });

  it.each([0.75, 1.25, 1.1])("closes a sway loop when the period is not on the frame grid (%ss)", (period) => {
    const { animation } = sway(chain, { bones: ["a", "b", "c"], period, amount: 10 });
    for (const b of ["a", "b", "c"]) {
      const keys = animation.bones![b]!.rotate as { value?: number }[];
      expect(keys.at(-1)!.value ?? 0).toBe(keys[0]!.value ?? 0);
    }
  });

  it("refuses looks that overlap instead of writing keys out of order", () => {
    expect(() => lookAt(chain, { bones: ["a"], looks: [{ time: 1, angle: 10 }, { time: 1.1, angle: -10 }] })).toThrow(/overlap/);
  });

  it("refuses a shut lid without a bone of its own", () => {
    const parts = [blob("head", 0, 0, 100, 100), blob("lid_L", 30, 30, 20, 10, { shut: true }), blob("hat", 20, 0, 60, 20)];
    expect(() => buildRig(parts, { bones: [{ name: "head", joint: [50, 90], tip: [50, 10], layers: ["head", "lid_L"] }, { name: "hat", parent: "head", joint: [50, 15], layers: ["hat"] }], mesh: "none", scale: 1 })).toThrow(/bone of its own/);
    expect(() => buildRig(parts, { bones: [{ name: "head", joint: [50, 90], tip: [50, 10], layers: ["head", "hat"] }], mesh: "none", scale: 1 })).toThrow(/bone of its own/);
  });

  it("builds its own suggestion when a limb's only child is a detail", () => {
    const parts = [blob("body", 80, 0, 80, 160), blob("thigh", 100, 150, 40, 90), blob("shin", 100, 230, 40, 90), blob("patch", 110, 270, 14, 14)];
    const sug = suggestRig(parts);
    expect(() => buildRig(parts, { bones: sug.bones, ik: sug.ik, mesh: "none", scale: 1 })).not.toThrow();
  });
});
