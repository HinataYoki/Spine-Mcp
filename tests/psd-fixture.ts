// Layered PSDs built from Bolt's part images at known canvas positions (top-left, y down).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initializeCanvas, writePsdBuffer, type Layer, type Psd } from "ag-psd";
import { PNG } from "pngjs";

initializeCanvas(() => { throw new Error("canvas not available"); }, (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) as unknown as ImageData);

const IMAGES = join(process.cwd(), "demo", "bolt", "images");
const img = (name: string) => { const p = PNG.sync.read(readFileSync(join(IMAGES, `${name}.png`))); return { width: p.width, height: p.height, data: new Uint8ClampedArray(p.data) }; };
const solid = (w: number, h: number, rgba: number[]) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < w * h; i++) d.set(rgba, i * 4); return { width: w, height: h, data: d }; };

export function layer(name: string, left: number, top: number, image: { width: number; height: number; data: Uint8ClampedArray }, extra: Partial<Layer> = {}): Layer {
  return { name, left, top, right: left + image.width, bottom: top + image.height, imageData: image as unknown as ImageData, ...extra };
}

export const POS: Record<string, [number, number]> = {
  shadow: [110, 520], "thigh-back": [172, 300], "shin-back": [160, 380], thigh: [192, 300], shin: [186, 380], torso: [137, 180],
  "upper-arm-back": [110, 190], "lower-arm-back": [100, 260], "upper-arm": [258, 190], "lower-arm": [262, 260], head: [141, 70], antenna: [194, 25], "antenna-ball": [185, 5],
};
const at = (name: string, extra: Partial<Layer> = {}) => layer(name, POS[name]![0], POS[name]![1], img(name), extra);

/** Groups without tags, a half-transparent shadow and one hidden draft layer. Children run bottom to top. */
export function plainPsd(): Psd {
  return {
    width: 400, height: 560,
    children: [
      at("shadow", { opacity: 0.5 }),
      { name: "legs", children: [at("thigh-back"), at("shin-back"), at("thigh"), at("shin")] },
      { name: "arms back", children: [at("upper-arm-back"), at("lower-arm-back")] },
      at("torso"),
      { name: "head", children: [at("antenna"), at("antenna-ball"), at("head")] },
      { name: "arms", children: [at("upper-arm"), at("lower-arm")] },
      layer("draft", 0, 0, solid(40, 40, [255, 0, 0, 255]), { hidden: true }),
    ],
  };
}

/** PhotoshopToSpine tags: [bone], [slot] (one visible, one hidden), [merge], [ignore], a multiply layer. */
export function taggedPsd(): Psd {
  return {
    width: 400, height: 560,
    children: [
      layer("guide [ignore]", 0, 0, solid(400, 10, [0, 255, 0, 255])),
      { name: "legs [merge]", children: [at("thigh-back"), at("shin-back"), at("thigh"), at("shin")] },
      { name: "body [bone]", children: [at("torso"), layer("tint", 150, 200, solid(20, 20, [0, 0, 0, 255]), { blendMode: "multiply" })] },
      { name: "head [bone]", children: [
        at("head"),
        { name: "eyes [slot]", children: [layer("open", 165, 100, solid(70, 20, [80, 255, 255, 255])), layer("closed", 165, 108, solid(70, 4, [20, 20, 40, 255]), { hidden: true })] },
      ] },
    ],
  };
}

export function writePsd(psd: Psd, file: string): string {
  writeFileSync(file, writePsdBuffer(psd));
  return file;
}
