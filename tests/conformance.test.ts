import { describe, expect, it } from "vitest";
import { compareRun, exitCode, normalizeFacts, toBaseline, type ProbeResult } from "../src/spine/conformance.js";

const probe = (id: string, facts: Record<string, unknown>, over: Partial<ProbeResult> = {}): ProbeResult => ({
  id, title: id, refs: [], protects: `${id}.ts`, critical: false, ok: true, facts, ...over,
});

describe("conformance compare", () => {
  const baseline = toBaseline("4.3.26", [
    probe("warn", { lines: ["Bone not found: x"], flagged: true }, { critical: true }),
    probe("keys", { times: [0, 0.5, 1] }),
    probe("gone", { a: 1 }),
  ]);

  it("reports identical facts as same and exits 0", () => {
    const run = [probe("warn", { lines: ["Bone not found: x"], flagged: true }, { critical: true }), probe("keys", { times: [0, 0.5, 1] }), probe("gone", { a: 1 })];
    const c = compareRun(baseline, run);
    expect(c.every((x) => x.status === "same")).toBe(true);
    expect(exitCode(c)).toBe(0);
  });

  it("flags a changed fact with before and after, and names the code it protects", () => {
    const c = compareRun(baseline, [probe("warn", { lines: ["Bone missing: x"], flagged: true }, { critical: true }), probe("keys", { times: [0, 0.5, 1] }), probe("gone", { a: 1 })]);
    const changed = c.find((x) => x.id === "warn")!;
    expect(changed.status).toBe("changed");
    expect(changed.changes).toEqual(['lines: ["Bone not found: x"] -> ["Bone missing: x"]']);
    expect(changed.protects).toBe("warn.ts");
    expect(c[0]!.id).toBe("warn"); // changes sort before same
    expect(exitCode(c)).toBe(2);
  });

  it("a failed critical probe exits 1; missing, new and skipped probes are reported", () => {
    const c = compareRun(baseline, [
      probe("warn", { flagged: false }, { critical: true, ok: false, note: "not flagged" }),
      probe("keys", {}, { ok: null, note: "fixture missing" }),
      probe("added", { x: 1 }),
    ]);
    expect(c.map((x) => [x.id, x.status])).toEqual([["warn", "failed"], ["keys", "skipped"], ["added", "new"], ["gone", "missing"]]);
    expect(exitCode(c)).toBe(1);
    expect(exitCode(compareRun(baseline, [probe("warn", { lines: ["Bone not found: x"], flagged: true }, { critical: true }), probe("keys", { times: [0, 0.5, 1] })]))).toBe(2);
  });

  it("without a baseline everything is new", () => {
    const c = compareRun(null, [probe("keys", { times: [0] })]);
    expect(c[0]!.status).toBe("new");
    expect(exitCode(c)).toBe(0);
  });

  it("normalizes the version under test and paths inside nested facts, longest token first", () => {
    const facts = { lines: ["/w/run/x.json: version 4.3.27", "keep 4.2.43"], nested: { spine: "4.3.27" }, n: 4 };
    expect(normalizeFacts(facts, { "<work>": "/w/run", "<repo>": "/w", "<v>": "4.3.27" }))
      .toEqual({ lines: ["<work>/x.json: version <v>", "keep 4.2.43"], nested: { spine: "<v>" }, n: 4 });
  });
});
