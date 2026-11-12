import { describe, expect, it } from "vitest";
import { diffSkeletons } from "../src/spine/reimport.js";
import type { SkeletonJson } from "../src/spine/types.js";

const QUAD = [0, 0, 40, 0, 40, 20, 0, 20];
const mesh = (vertices: number[]) => ({ type: "mesh", uvs: [0, 0, 1, 0, 1, 1, 0, 1], triangles: [0, 1, 2, 2, 3, 0], hull: 4, width: 40, height: 20, vertices });
// Each vertex 50/50 on arm (1) and hand (2).
const WEIGHTED = [0, 1, 2, 3].flatMap((i) => [2, 1, QUAD[i * 2]!, QUAD[i * 2 + 1]!, 0.5, 2, QUAD[i * 2]!, QUAD[i * 2 + 1]!, 0.5]);

function rig(): SkeletonJson {
  return {
    skeleton: { spine: "4.3.26" },
    bones: [{ name: "root" }, { name: "arm", parent: "root", rotation: 30, length: 50 }, { name: "hand", parent: "arm", x: 50, length: 10 }],
    slots: [
      { name: "arm", bone: "arm", attachment: "arm" },
      { name: "body", bone: "root", attachment: "body" },
      { name: "eyes", bone: "root", attachment: "eyes-open" },
    ],
    skins: [{
      name: "default",
      attachments: {
        arm: { arm: mesh(WEIGHTED) },
        body: { body: mesh(QUAD) },
        eyes: { "eyes-open": { width: 20, height: 10 }, "eyes-closed": { width: 20, height: 10 } },
      },
    }],
    animations: {
      blink: { slots: { eyes: { attachment: [{ time: 0.2, name: "eyes-closed" }, { time: 0.3, name: "eyes-open" }] } } },
      wave: {
        bones: { arm: { rotate: [{ value: 0 }, { time: 0.5, value: 20 }, { time: 1, value: 0 }] } },
        attachments: { default: { body: { body: { deform: [{ vertices: [0, 0] }, { time: 0.5, vertices: [5, 5] }, { time: 1, vertices: [0, 0] }] } } } },
      },
    },
  } as unknown as SkeletonJson;
}

describe("spine_reimport_diff", () => {
  it("reports nothing for an identical project", () => {
    const d = diffSkeletons(rig(), rig());
    expect(d.broken).toEqual([]);
    expect(d.changed).toEqual([]);
    expect(d.animations).toEqual([]);
  });

  it("an attachment deleted with its keys: lost visibility keys, and blink plays differently", () => {
    const after = rig();
    delete (after.skins![0]!.attachments!.eyes as Record<string, unknown>)["eyes-closed"];
    after.animations!.blink = {};
    const d = diffSkeletons(rig(), after);
    expect(d.broken).toContainEqual({ where: "animation blink", detail: expect.stringMatching(/2 key\(s\) lost/) });
    expect(d.notes.join("\n")).toMatch(/attachment visibility keys of eyes are gone/);
    expect(d.animations.find((a) => a.animation === "blink")!.behaviour.attachmentChanges[0]).toMatch(/eyes: eyes-closed → eyes-open/);
  });

  it("weights wiped: broken, and the mesh moves when the hand bone does", () => {
    const after = rig();
    after.skins![0]!.attachments!.arm!.arm = mesh(QUAD) as never;
    const d = diffSkeletons(rig(), after);
    expect(d.broken).toContainEqual({ where: "attachment default/arm/arm", detail: expect.stringMatching(/weights lost \(was weighted to 2 bones/) });
  });

  it("a mesh turned into a region: broken, its deform keys are lost", () => {
    const after = rig();
    after.skins![0]!.attachments!.body!.body = { width: 40, height: 20 } as never;
    delete after.animations!.wave!.attachments;
    const d = diffSkeletons(rig(), after);
    expect(d.broken).toContainEqual({ where: "attachment default/body/body", detail: expect.stringMatching(/type mesh → region/) });
    expect(d.broken).toContainEqual({ where: "animation wave", detail: expect.stringMatching(/3 key\(s\) lost/) });
  });

  it("an image resized and a setup rotation changed: changed, with the playback difference", () => {
    const after = rig();
    (after.skins![0]!.attachments!.eyes!["eyes-open"] as { width: number }).width = 30;
    after.bones[1]!.rotation = 45;
    const d = diffSkeletons(rig(), after);
    expect(d.changed).toContainEqual({ where: "attachment default/eyes/eyes-open", detail: "image size 20x10 → 30x10" });
    expect(d.changed).toContainEqual({ where: "bone arm", detail: "setup rotation 30 → 45" });
    expect(d.broken).toEqual([]);
    expect(d.animations.find((a) => a.animation === "wave")!.behaviour.maxBoneMove).toBeGreaterThan(5);
  });

  it("an attachment key Spine rewrote to none after its attachment was deleted", () => {
    const after = rig();
    delete (after.skins![0]!.attachments!.eyes as Record<string, unknown>)["eyes-closed"];
    after.animations!.blink!.slots!.eyes!.attachment![0]!.name = null;
    const d = diffSkeletons(rig(), after);
    expect(d.broken).toContainEqual({ where: "animation blink", detail: expect.stringMatching(/at 0.2s "eyes-closed" → "none" \(attachment deleted/) });
  });
});
