import { describe, expect, it } from "vitest";
import { editAnimation } from "../src/spine/keyframes.js";
import type { AnimationJson } from "../src/spine/types.js";

const source: AnimationJson = {
  bones: { head: { rotate: [{ value: 0 }, { time: 2, value: 20 }], translate: [{ x: 4, y: 5 }] } },
  slots: { eyes: { attachment: [{ name: "open" }] } },
};
const path = ["bones", "head", "rotate"];
describe("animation keyframe editing", () => {
  it("duplicates deeply without modifying the source", () => {
    const copy = editAnimation(source, []);
    copy.bones!.head!.rotate![0]!.value = 99;
    expect(source.bones!.head!.rotate![0]!.value).toBe(0);
  });
  it("upserts entire keys while preserving unrelated timelines", () => {
    const copy = editAnimation(source, [{ op: "set", path, keys: [{ time: 2, value: 8 }, { time: 1, value: 4 }] }]);
    expect(copy.bones!.head!.rotate!.map(k => k.value)).toEqual([0, 4, 8]);
    expect(copy.slots).toEqual(source.slots);
    expect(copy.bones!.head!.translate).toEqual(source.bones!.head!.translate);
    expect(source.bones!.head!.rotate).toHaveLength(2);
  });
  it("rejects append collisions, even within one request", () => {
    expect(() => editAnimation(source, [{ op: "set", path, mode: "append", keys: [{ value: 5 }] }])).toThrow("already exists");
    expect(() => editAnimation(source, [{ op: "set", path, mode: "append", keys: [{ time: 1 }, { time: 1 }] }])).toThrow("already exists");
  });
  it("replaces one track and converts normalized curves to absolute coordinates", () => {
    const copy = editAnimation(source, [{ op: "set", path, mode: "replace", easing: [0.25, 0, 0.75, 1], keys: [{ time: 1, value: 10 }, { time: 3, value: 30 }] }]);
    expect(copy.bones!.head!.rotate![0]!.curve).toEqual([1.5, 10, 2.5, 30]);
    expect(copy.bones!.head!.rotate![1]!.curve).toBeUndefined();
  });
  it("rescales existing curve handles when deleting their endpoint", () => {
    const copy = editAnimation({ bones: { head: { rotate: [{ value: 0, curve: [0.25, 0, 0.75, 10] }, { time: 1, value: 10 }, { time: 2, value: 20 }] } } }, [{ op: "delete", path, times: [1] }]);
    expect(copy.bones!.head!.rotate![0]!.curve).toEqual([0.5, 0, 1.5, 20]);
  });
  it("prunes only empty ancestors and reports missing times", () => {
    const copy = editAnimation(source, [{ op: "delete", path }]);
    expect(copy.bones!.head!.rotate).toBeUndefined();
    expect(copy.bones!.head!.translate).toBeDefined();
    expect(() => editAnimation(source, [{ op: "delete", path, times: [9] }])).toThrow("No keys match");
  });
  it("supports slot color and multi-channel IK easing", () => {
    const copy = editAnimation({}, [
      { op: "set", path: ["slots", "eyes", "rgba"], easing: "ease-in-out", keys: [{ color: "000000ff" }, { time: 2, color: "ffffffff" }] },
      { op: "set", path: ["ik", "leg"], easing: "smooth", keys: [{ mix: 0, softness: 0 }, { time: 2, mix: 1, softness: 10 }] },
    ]);
    expect(copy.slots!.eyes!.rgba![0]!.curve).toHaveLength(16);
    expect(copy.ik!.leg![0]!.curve).toEqual([0.5, 0, 1.5, 1, 0.5, 0, 1.5, 10]);
  });
  it("addresses attachment names containing slashes and events at the same time", () => {
    const copy = editAnimation({}, [
      { op: "set", path: ["attachments", "default", "eye/L", "eye/open", "deform"], keys: [{ vertices: [1, 2] }] },
      { op: "set", path: ["events"], keys: [{ name: "a" }, { name: "b" }] },
    ]);
    expect(copy.attachments!.default!["eye/L"]!["eye/open"]!.deform).toHaveLength(1);
    expect(copy.events).toHaveLength(2);
  });
  it("rejects invalid times, unsafe paths and unsupported easing without mutating source", () => {
    for (const value of [-1, NaN, Infinity]) expect(() => editAnimation(source, [{ op: "set", path, keys: [{ time: value }] }])).toThrow("finite");
    expect(() => editAnimation(source, [{ op: "set", path: ["bones", "__proto__", "rotate"], keys: [{}] }])).toThrow("Unsafe");
    expect(() => editAnimation(source, [{ op: "set", path: ["events"], keys: [{ name: "a" }], easing: "ease" }])).toThrow("unsupported");
    expect(() => editAnimation(source, [{ op: "set", path, keys: [{}], easing: [2, 0, 1, 1] }])).toThrow("time handles");
    expect(source.bones!.head!.rotate).toHaveLength(2);
  });
});
