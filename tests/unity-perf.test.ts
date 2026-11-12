// spine_unity_check perf: the report built from the player's raw numbers (baseline subtraction, the checks that the
// work happened, threaded speedup, garbage per frame).
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { SpineCli } from "../src/spine/cli.js";
import { perfReport, unityPerfRaw, type PerfRawReport, type PerfRawRun } from "../src/spine/unity-perf.js";

const stats = (median: number) => ({ median, p95: median * 1.2, mean: median, max: median * 1.5 });
const run = (o: Partial<PerfRawRun> & { count: number; mode: string; main: number }): PerfRawRun => ({
  animation: "walk", frameMs: stats(0.1 + o.main), updateMs: stats(o.main * 0.4), lateUpdateMs: stats(o.main * 0.6), gcBytesPerFrame: 0,
  vertices: o.count ? [276, 276] : null, meshChanged: o.count > 0, threadedSystem: o.mode === "threaded",
  registered: o.mode === "threaded" ? [o.count, o.count] : [0, 0], pose: [0.6, 4.9], ...o,
});

function raw(runs: PerfRawRun[], o: Partial<PerfRawReport> = {}): PerfRawReport {
  return {
    unityVersion: "6000.6.2f1", backend: "Mono", system: { processor: "Apple M5", cores: 10, os: "macOS", graphics: "Null" }, frames: 240, warmup: 30,
    control: run({ animation: "", count: 0, mode: "single", main: 0.0002, gcBytesPerFrame: 1150 }), baseline: run({ animation: "", count: 0, mode: "single", main: 0.0002 }),
    runs, errors: [], budget: { walk: { vertexTransforms: 462, clippedTriangles: 0, drawCalls: 1 } }, ...o,
  };
}

describe("perf report", () => {
  it("subtracts the empty loop, gives microseconds per skeleton and the threaded speedup at the largest count", () => {
    const r = perfReport(raw([
      run({ count: 1, mode: "single", main: 0.0142 }), run({ count: 1, mode: "threaded", main: 0.0392 }),
      run({ count: 100, mode: "single", main: 1.1202 }), run({ count: 100, mode: "threaded", main: 0.5002 }),
    ]));
    expect(r.runs.find((x) => x.count === 100 && x.mode === "single")).toMatchObject({ mainThreadMs: 1.12, usPerSkeleton: 11.2 });
    const walk = r.animations[0]!;
    expect(walk).toMatchObject({ animation: "walk", threadedSpeedup: 2.24, gcBytesPerFrame: 0, budget: { vertexTransforms: 462 } });
    expect(walk.usPerSkeleton).toEqual({ "1": 14, "100": 11.2 });
    expect(r.gcResolution).toBe(17.1);
    expect(r.warnings).toEqual([]);
    // One skeleton costs the main thread more threaded than alone: said, not hidden.
    expect(r.notes.join(" ")).toMatch(/walk: the threaded update costs the main thread more than the single-threaded one at 1 skeleton/);
    expect(r.notes.join(" ")).toMatch(/not on a phone/);
    // Skins: the default one measured while the skeleton has others is said.
    expect(perfReport(raw([], { skin: "default", skins: ["goblin", "goblingirl"] })).notes.join(" ")).toMatch(/default skin; this skeleton also has goblin, goblingirl: pass perf.skin/);
    expect(perfReport(raw([], { skin: "goblin", skins: ["goblin", "goblingirl"] })).notes.join(" ")).not.toMatch(/pass perf.skin/);
  });

  it("warns when the work did not happen: no mesh, threading not on, a different pose, an allocation control that does not read", () => {
    const r = perfReport(raw([
      run({ count: 10, mode: "single", main: 0.1, vertices: null }),
      run({ count: 10, mode: "threaded", main: 0.05, registered: [4, 10], pose: [0.7, 4.9] }),
    ], { control: run({ animation: "", count: 0, mode: "single", main: 0.0002, gcBytesPerFrame: 0 }) }));
    const all = r.warnings.join(" | ");
    expect(all).toMatch(/walk x10 single: no mesh was generated/);
    expect(all).toMatch(/walk x10 threaded: spine-unity's threaded update ran 4 animation\(s\) and 10 renderer\(s\) of 10/);
    expect(all).toMatch(/walk x10 threaded: the threaded pose differs/);
    expect(all).toMatch(/allocation control read 0 bytes/);
  });

  it("says when threaded workers run past LateUpdate (the frame well above the main thread)", () => {
    const r = perfReport(raw([run({ count: 100, mode: "threaded", main: 0.5, frameMs: stats(0.1 + 1.0) })]));
    expect(r.warnings.join(" ")).toMatch(/walk x100 threaded: the whole frame \(1 ms\) is well above the main thread's 0\.5 ms/);
    expect(perfReport(raw([run({ count: 100, mode: "threaded", main: 0.5 })])).warnings).toEqual([]);
  });

  it("reports garbage per frame above the resolution, per skeleton, with the clipping it does", () => {
    const r = perfReport(raw([run({ count: 50, mode: "single", main: 2.1, gcBytesPerFrame: 26000 })], { budget: { walk: { vertexTransforms: 513, clippedTriangles: 343, drawCalls: 4 } } }));
    expect(r.animations[0]!.gcBytesPerFrame).toBe(26000);
    expect(r.warnings.join(" ")).toMatch(/walk: 26000 bytes of managed garbage per frame with 50 skeleton\(s\) \(about 520 each\).*clips 343 triangles/);
    // Under twice the resolution is noise.
    expect(perfReport(raw([run({ count: 50, mode: "single", main: 0.5, gcBytesPerFrame: 30 })])).warnings).toEqual([]);
  });
});

describe("perf limits", () => {
  it("refuses counts and frame numbers that would run for too long, before starting Unity", async () => {
    const cli = {} as SpineCli, config = loadConfig();
    for (const o of [{ counts: [0] }, { counts: [1000] }, { counts: [2.5] }, { frames: 10 }, { frames: 100000 }]) {
      await expect(unityPerfRaw(config, cli, { project: "/x.spine", ...o })).rejects.toThrow(/counts from 1 to 500 skeletons, frames from 60 to 3000/);
    }
  });
});

