import { describe, expect, it } from "vitest";
import { zeroTinyValues } from "../src/spine/write.js";

describe("values Spine stores as 0", () => {
  it("writes bone rotate, translate and shear values under 0.005 as 0, as Spine's import keeps them", () => {
    const a = zeroTinyValues({ bones: { b: { rotate: [{ value: -0.0046 }, { time: 1, value: 0.0055 }], translate: [{ x: 0.004, y: -0.2 }], scale: [{ x: 1.004, y: 0.002 }] } } });
    expect(a.bones!.b!.rotate).toEqual([{ value: 0 }, { time: 1, value: 0.0055 }]);
    expect(a.bones!.b!.translate).toEqual([{ x: 0, y: -0.2 }]);
    expect(a.bones!.b!.scale).toEqual([{ x: 1.004, y: 0.002 }]); // scale is a factor: left alone
  });
});
