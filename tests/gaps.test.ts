// Joint gaps: background reaching a bent joint's pivot between two parts, in animations and under a stress turn.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { jointGaps, OPEN_REACH, stressJoints, type Img } from "../src/spine/gaps.js";
import { rigQa } from "../src/spine/rigqa.js";
import { loadSkeletonData } from "../src/spine/runtime.js";
import type { SkeletonJson } from "../src/spine/types.js";
import { validateSkeleton } from "../src/spine/validate.js";

/**
 * An arm of two 20-unit-thick parts on bones upper and lower (the elbow at x 100). `overlap`: how far the upper part
 * runs past the elbow. `cap`: a round mesh of radius 10 over the elbow. `ghost`: a square image over the elbow, drawn
 * only where its pixels are (transparent here).
 */
function arm(o: { overlap?: number; cap?: boolean; ghost?: boolean } = {}): SkeletonJson {
  const overlap = o.overlap ?? 0, ring: number[] = [];
  for (let k = 0; k < 16; k++) { const a = (k / 16) * Math.PI * 2; ring.push(Math.cos(a) * 10, Math.sin(a) * 10); }
  const fan: number[] = [];
  for (let k = 1; k < 15; k++) fan.push(0, k, k + 1);
  return {
    skeleton: { spine: "4.3.26" },
    bones: [{ name: "root" }, { name: "body", parent: "root" }, { name: "upper", parent: "body", length: 100 }, { name: "lower", parent: "upper", x: 100, length: 100 }],
    slots: [
      { name: "up", bone: "upper", attachment: "up" }, { name: "low", bone: "lower", attachment: "low" },
      ...(o.cap ? [{ name: "cap", bone: "lower", attachment: "cap" }] : []), ...(o.ghost ? [{ name: "ghost", bone: "lower", attachment: "ghost" }] : []),
    ],
    skins: [{ name: "default", attachments: {
      up: { up: { x: 50 + overlap / 2, width: 100 + overlap, height: 20 } },
      low: { low: { x: 50, width: 100, height: 20 } },
      ...(o.cap ? { cap: { cap: { type: "mesh", uvs: ring.map((v) => 0.5 + v / 20), triangles: fan, vertices: ring, hull: 16, width: 20, height: 20 } } } : {}),
      ...(o.ghost ? { ghost: { ghost: { width: 40, height: 40 } } } : {}),
    } }],
    animations: {
      bend: { bones: { lower: { rotate: [{ value: 0 }, { time: 1, value: 90 }] } } },
      // The forearm slides off the elbow: a moving part, not a hinge (left out).
      slide: { bones: { lower: { translate: [{ x: 0 }, { time: 1, x: 40 }] } } },
      still: { bones: { lower: { rotate: [{ value: 0 }, { time: 1, value: 5 }] } } },
    },
  } as unknown as SkeletonJson;
}

const solid = (w: number, h: number, alpha = 255): Img => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(alpha) });
const images = (ghostAlpha: number) => (path: string): Img | null => (path === "ghost" ? solid(8, 8, ghostAlpha) : solid(8, 8));

describe("joints opening in animations", () => {
  it("finds two square ends meeting at the pivot opening as the elbow bends, and leaves overlapping and capped joints alone", () => {
    const data = loadSkeletonData(arm());
    const [g] = jointGaps(data, data.findAnimation("bend")!);
    expect(g).toMatchObject({ bone: "lower", parent: "upper", skin: "default" });
    expect(g!.slots.sort()).toEqual(["low", "up"]);
    expect(g!.reach).toBeLessThan(OPEN_REACH);
    // About the half thickness: the disk may reach a little past the sides (97% covered).
    expect(g!.radius).toBeGreaterThan(9);
    expect(g!.radius).toBeLessThan(13);
    expect(g!.time).toBeGreaterThan(0.5);
    for (const o of [{ overlap: 10 }, { cap: true }]) {
      const d = loadSkeletonData(arm(o));
      expect(jointGaps(d, d.findAnimation("bend")!).every((x) => x.reach >= OPEN_REACH), JSON.stringify(o)).toBe(true);
    }
  });

  it("leaves sliding parts and small turns out", () => {
    const data = loadSkeletonData(arm());
    expect(jointGaps(data, data.findAnimation("slide")!)).toEqual([]);
    expect(jointGaps(data, data.findAnimation("still")!)).toEqual([]);
  });

  it("leaves joints alone whose pivot already shows background at setup", () => {
    // The forearm starts 15 units past the elbow: the pivot lies in the background before anything bends.
    const doc = arm() as unknown as { skins: { attachments: { low: { low: { x: number } } } }[] };
    doc.skins[0]!.attachments.low.low.x = 65;
    const data = loadSkeletonData(doc as unknown as SkeletonJson);
    expect(jointGaps(data, data.findAnimation("bend")!)).toEqual([]);
    expect(stressJoints(data)).toEqual([]);
  });

  it("counts only drawn pixels when the images are there", () => {
    const data = loadSkeletonData(arm({ ghost: true }));
    const bend = data.findAnimation("bend")!;
    // Without images the ghost's square covers the elbow; with its transparent pixels the gap shows.
    expect(jointGaps(data, bend).every((g) => g.reach >= OPEN_REACH)).toBe(true);
    expect(jointGaps(data, bend, 30, images(255)).every((g) => g.reach >= OPEN_REACH)).toBe(true);
    expect(jointGaps(data, bend, 30, images(0)).some((g) => g.bone === "lower" && g.reach < OPEN_REACH)).toBe(true);
  });

  it("warns in spine_validate", () => {
    const issues = validateSkeleton(arm(), {}).filter((i) => i.code === "joint-opens");
    expect(issues.map((i) => i.where)).toEqual(["animations/bend"]);
    expect(issues[0]!.message).toMatch(/upper > lower opens at/);
    expect(validateSkeleton(arm({ cap: true }), {}).some((i) => i.code === "joint-opens")).toBe(false);
  });
});

describe("joints under a stress turn", () => {
  it("finds the smallest turn that opens a joint, and none on a capped one", () => {
    const [s] = stressJoints(loadSkeletonData(arm()));
    expect(s).toMatchObject({ bone: "lower", parent: "upper" });
    expect(Math.abs(s!.degrees)).toBeLessThanOrEqual(60);
    expect(stressJoints(loadSkeletonData(arm({ cap: true })))).toEqual([]);
  });

  it("is reported by rig QA with the project's images", () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-gaps-"));
    mkdirSync(join(dir, "images"));
    for (const [name, alpha] of [["up", 255], ["low", 255], ["ghost", 0]] as const) {
      const png = new PNG({ width: 8, height: 8 });
      png.data.fill(alpha);
      writeFileSync(join(dir, "images", `${name}.png`), PNG.sync.write(png));
    }
    const doc = arm({ ghost: true });
    const item = (d: string | undefined) => rigQa(doc, { baseDir: d }).findings.find((f) => f.code === "gap-prone-joints")?.items ?? [];
    expect(item(dir)[0]).toMatch(/^upper > lower at -?\d+°/);
    // Without the images the ghost's square covers the elbow.
    expect(item(undefined)).toEqual([]);
  });
});
