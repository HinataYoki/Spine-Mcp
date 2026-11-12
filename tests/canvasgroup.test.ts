// spine_unity_check canvasGroup: a SkeletonGraphic faded through a CanvasGroup against the right blend.
import { describe, expect, it } from "vitest";
import { fadeError } from "../src/spine/canvasgroup.js";

const G = 127;
// A frame of w x 1 pixels: art (premultiplied colour pm, coverage a) over the grey background.
const frame = (pixels: { pm: [number, number, number]; a: number }[]) => {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach((p, i) => data.set([...p.pm.map((c) => Math.round(c + G * (1 - p.a))), 255], i * 4));
  return { width: pixels.length, height: 1, data };
};

describe("CanvasGroup fade", () => {
  const art = [{ pm: [200, 40, 10] as [number, number, number], a: 1 }, { pm: [60, 60, 0] as [number, number, number], a: 0.5 }, { pm: [0, 0, 0] as [number, number, number], a: 0 }];
  const full = frame(art);

  it("is right when colour and coverage both scale by the group alpha", () => {
    const right = frame(art.map((p) => ({ pm: p.pm.map((c) => c * 0.5) as [number, number, number], a: p.a * 0.5 })));
    expect(fadeError(full, right, 0.5, G)).toEqual({ meanDiff: expect.any(Number), visiblePercent: 0 });
    expect(fadeError(full, right, 0.5, G).meanDiff).toBeLessThan(1);
  });

  it("is off when only the alpha scales (PMA colours not multiplied: the art turns bright, not faded)", () => {
    const wrong = frame(art.map((p) => ({ pm: p.pm, a: p.a * 0.5 })));
    const e = fadeError(full, wrong, 0.5, G);
    expect(e.visiblePercent).toBe(100);
    expect(e.meanDiff).toBeGreaterThan(20);
    // Background pixels are not counted; a frame of another size is all wrong.
    expect(fadeError(frame([art[2]!]), frame([art[2]!]), 0.5, G)).toEqual({ meanDiff: 0, visiblePercent: 0 });
    expect(fadeError(full, frame([art[0]!]), 0.5, G).visiblePercent).toBe(100);
  });
});
