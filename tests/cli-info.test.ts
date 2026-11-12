import { describe, expect, it } from "vitest";
import { parseCliOutput } from "../src/spine/cli.js";
import { parseProjectInfo } from "../src/spine/info.js";

// Captured from Spine 4.3.26 (research/phase0).
const IMPORT_LOG = `Spine Launcher 4.3.08 (macOS Apple Silicon)
Esoteric Software LLC (C) 2013-2026 | http://esotericsoftware.com
Starting: Spine 4.3.26 Professional
Spine 4.3.26 Professional
Licensed to: Someone <someone@example.com>
Animation import: in.json into proj (proj)
Imported animation: missing_bone
Bone not found: [bone: ghost-bone, animation: missing_bone, skeleton: in]
An animation with this name already exists: idle -> idle2
Complete.`;

const ERROR_LOG = `Spine 4.3.26 Professional
   at s.AiM._(_:197) ...
Cause: [serialize] Parent bone not found: nope
ERROR: Input path does not exist:`;

const INFO = `Project info: /p/two.spine
  Spine version: 4.3.26
  Dopesheet FPS: 30
  Skeleton: hero
    Size: 418.4499 x 686.2023
    Bones (3): root, hip, torso
    IK constraints (1): leg-ik
    Physics constraints (2): hair, tail
    Animations (2): idle, walk
  Skeleton: second
    Size: 10 x 20
    Sliders (1): rotation
    Animations (1): idle
Project info: null
  Spine version: null
  Dopesheet FPS: 30
  Skeleton: owl-pro
    Size: 1350.8373 x 909.407`;

describe("parseCliOutput", () => {
  it("strips the banner and classifies dropped data as warnings", () => {
    const r = parseCliOutput(IMPORT_LOG);
    expect(r.lines.some((l) => l.includes("Licensed"))).toBe(false);
    expect(r.lines[0]).toBe("Animation import: in.json into proj (proj)");
    expect(r.warnings).toHaveLength(2);
    expect(r.errors).toHaveLength(0);
  });

  it("collects ERROR and Cause lines", () => {
    const r = parseCliOutput(ERROR_LOG);
    expect(r.errors).toEqual(["Cause: [serialize] Parent bone not found: nope", "ERROR: Input path does not exist:"]);
  });
});

describe("parseProjectInfo", () => {
  it("parses several projects and skeletons", () => {
    const [p1, p2] = parseProjectInfo(INFO.split("\n"));
    expect(p1!.path).toBe("/p/two.spine");
    expect(p1!.dopesheetFps).toBe(30);
    expect(p1!.skeletons.map((s) => s.name)).toEqual(["hero", "second"]);
    expect(p1!.skeletons[0]!.width).toBeCloseTo(418.4499);
    expect(p1!.skeletons[0]!.lists["Physics constraints"]).toEqual({ count: 2, names: ["hair", "tail"] });
    expect(p1!.skeletons[1]!.lists["Sliders"]!.names).toEqual(["rotation"]);
    expect(p2!.path).toBeNull();
    expect(p2!.spineVersion).toBeNull();
  });
});
