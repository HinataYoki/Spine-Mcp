// Folders of PNG parts with a layout, made from Bolt's part images at the PSD fixture's canvas positions: the three
// layouts spine_import_layers reads (spine-mcp's own, See-through's layout.json, a cutting tool's parts.json).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { POS } from "./psd-fixture.js";

export const IMAGES = join(process.cwd(), "DFY", "images");
/** Bolt's parts in draw order (back to front), as plainPsd() stacks them. */
export const ORDER = ["shadow", "thigh-back", "shin-back", "thigh", "shin", "upper-arm-back", "lower-arm-back", "torso", "antenna", "antenna-ball", "head", "upper-arm", "lower-arm"];
const GROUP: Record<string, string> = { "thigh-back": "legs", "shin-back": "legs", thigh: "legs", shin: "legs", "upper-arm-back": "arms back", "lower-arm-back": "arms back", antenna: "head", "antenna-ball": "head", head: "head", "upper-arm": "arms", "lower-arm": "arms" };
export const sizeOf = (name: string) => { const p = PNG.sync.read(readFileSync(join(IMAGES, `${name}.png`))); return { w: p.width, h: p.height }; };

/** spine-mcp's own layout: parts listed back to front, with bones, a pivot and the shadow at half opacity. */
export function writeOwnLayout(dir: string, extra: { bones?: unknown[]; pivots?: Record<string, [number, number]> } = {}): string {
  mkdirSync(dir, { recursive: true });
  for (const n of ORDER) copyFileSync(join(IMAGES, `${n}.png`), join(dir, `${n}.png`));
  const parts = ORDER.map((n) => ({ file: `${n}.png`, x: POS[n]![0], y: POS[n]![1], ...(GROUP[n] ? { bone: GROUP[n] } : {}), ...(n === "shadow" ? { opacity: 0.5 } : {}), ...(extra.pivots?.[n] ? { pivot: extra.pivots[n] } : {}) }));
  writeFileSync(join(dir, "layout.json"), JSON.stringify({ width: 400, height: 560, ...(extra.bones ? { bones: extra.bones } : {}), parts }, null, 2));
  return dir;
}

/** See-through's export: layers/NN_name.png and layout.json one level up, with order, box and its extra fields. */
export function writeSeeThrough(dir: string): string {
  mkdirSync(join(dir, "layers"), { recursive: true });
  const layers = ORDER.map((n, i) => {
    const file = `layers/${String(i).padStart(2, "0")}_${n}.png`, { w, h } = sizeOf(n);
    copyFileSync(join(IMAGES, `${n}.png`), join(dir, file));
    return { order: i, tag: n, name: n, file, x: POS[n]![0], y: POS[n]![1], w, h, spine_center: [POS[n]![0] + w / 2 - 200, 560 - POS[n]![1] - h / 2], depth_median: 1 - i / ORDER.length, owned_px: 100 };
  });
  // Listed in reverse: the order field, not the list, gives the draw order.
  writeFileSync(join(dir, "layout.json"), JSON.stringify({ source: join(dir, "source.png"), width: 400, height: 560, layers: layers.reverse() }, null, 2));
  return dir;
}

/**
 * A cutting tool's output: parts.json beside parts/ (the cut) and parts_filled/ (the cut grown by 6 px to the left and top,
 * as painted fill under neighbours), each entry with its cut box, its filled box and a draw order, plus metadata keys.
 */
export function writeCutBoxes(dir: string): string {
  mkdirSync(join(dir, "parts"), { recursive: true });
  mkdirSync(join(dir, "parts_filled"), { recursive: true });
  const layout: Record<string, unknown> = { _otsu: { torso: 90 } };
  // Entries written front to back: draw_order, not their order in the file, stacks them.
  [...ORDER].reverse().forEach((n) => {
    const i = ORDER.indexOf(n), src = PNG.sync.read(readFileSync(join(IMAGES, `${n}.png`)));
    copyFileSync(join(IMAGES, `${n}.png`), join(dir, "parts", `${n}.png`));
    const grown = new PNG({ width: src.width + 6, height: src.height + 6 });
    for (let y = 0; y < src.height; y++) src.data.copy(grown.data, ((y + 6) * grown.width + 6) * 4, y * src.width * 4, (y + 1) * src.width * 4);
    writeFileSync(join(dir, "parts_filled", `${n}.png`), PNG.sync.write(grown));
    layout[n] = { x: POS[n]![0], y: POS[n]![1], w: src.width, h: src.height, px: 1, draw_order: i, filled: { x: POS[n]![0] - 6, y: POS[n]![1] - 6, w: grown.width, h: grown.height, fill_px: 0, bleed: { bottom: 0, left: 0 } } };
  });
  writeFileSync(join(dir, "parts.json"), JSON.stringify(layout, null, 1));
  return dir;
}
