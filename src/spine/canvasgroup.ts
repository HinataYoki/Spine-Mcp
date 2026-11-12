import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";

/** The group alpha spine_unity_check canvasGroup fades the SkeletonGraphic to. */
export const GROUP_ALPHA = 0.5;
// A faded frame is off where a channel misses the expected blend by this much (0-255); reported from this share of
// the drawn pixels on.
const VISIBLE = 8;
export const FADE_OFF_PERCENT = 2;

export interface FadeError {
  /** Mean channel difference from the expected blend over the drawn pixels (0-255). */
  meanDiff: number;
  /** Drawn pixels where a channel misses it by 8/255 or more. */
  visiblePercent: number;
}

type Rgba = { width: number; height: number; data: Uint8Array | Uint8ClampedArray | Buffer };

/**
 * How far a faded frame is from a reference over the pixels the full frame F draws. Without a reference: from the
 * character faded as one layer, G + a (F - G) over the grey background G (what a layer opacity in Spine or an image
 * editor gives).
 */
export function fadeError(full: Rgba, faded: Rgba, alpha: number, grey: number, reference?: Rgba): FadeError {
  if (full.width !== faded.width || full.height !== faded.height || (reference && (reference.width !== full.width || reference.height !== full.height))) return { meanDiff: 255, visiblePercent: 100 };
  let drawn = 0, sum = 0, visible = 0;
  for (let i = 0; i < full.data.length; i += 4) {
    let isDrawn = false, worst = 0, d = 0;
    for (let c = 0; c < 3; c++) {
      const f = full.data[i + c]!;
      if (Math.abs(f - grey) > 2) isDrawn = true;
      const e = Math.abs(faded.data[i + c]! - (reference ? reference.data[i + c]! : grey + alpha * (f - grey)));
      d += e; worst = Math.max(worst, e);
    }
    if (!isDrawn) continue;
    drawn++; sum += d / 3;
    if (worst >= VISIBLE) visible++;
  }
  return { meanDiff: drawn ? +(sum / drawn).toFixed(2) : 0, visiblePercent: drawn ? +(100 * visible / drawn).toFixed(2) : 0 };
}

const readPng = (file: string) => PNG.sync.read(readFileSync(file));

/**
 * Every frame of one animation's folder (frame_000.png ...): the frames in `sub` against those in `referenceSub` (or
 * the one-layer fade without it); the worst frame counts.
 */
export function fadeFolder(dir: string, sub: string, alpha: number, grey: number, referenceSub?: string): FadeError | null {
  const fadedDir = join(dir, sub), refDir = referenceSub ? join(dir, referenceSub) : null;
  if (!existsSync(fadedDir) || (refDir && !existsSync(refDir))) return null;
  let worst: FadeError | null = null;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".png")).sort()) {
    if (!existsSync(join(fadedDir, f)) || (refDir && !existsSync(join(refDir, f)))) continue;
    const e = fadeError(readPng(join(dir, f)), readPng(join(fadedDir, f)), alpha, grey, refDir ? readPng(join(refDir, f)) : undefined);
    if (!worst || e.visiblePercent > worst.visiblePercent) worst = e;
  }
  return worst;
}
