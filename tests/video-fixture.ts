// A video with known answers, made from Bolt renders: on twos with one stutter, the same slowed to 0.25x, a hard cut,
// a crossfade, on ones with one dropped frame, a white flash, one black frame, an audio click at a known frame, and a
// frame counter above the character that changes every frame (why inspection wants a crop). Encoded with visible
// compression (crf 28) so repeats are not exactly zero.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import type { SpineCli } from "../src/spine/cli.js";
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { renderFrames } from "../src/spine/render.js";

/** Index of the frame in the middle of the steadiest fast stretch (where a missing frame shows as a doubled step). */
function fastestStep(frames: string[]): number {
  const imgs = frames.map((f) => PNG.sync.read(readFileSync(f)));
  const step = imgs.map((p, k) => {
    if (!k) return 0;
    const q = imgs[k - 1]!;
    let s = 0;
    for (let i = 0; i < p.data.length; i += 4) s += Math.abs(p.data[i]! - q.data[i]!);
    return s;
  });
  let best = 2, score = -1;
  for (let k = 3; k < step.length - 3; k++) {
    const around = [step[k - 2]!, step[k - 1]!, step[k + 1]!, step[k + 2]!, step[k]!];
    const lo = Math.min(...around), hi = Math.max(...around);
    const s = lo > 0 && hi / lo < 1.3 ? lo : -1;
    if (s > score) { score = s; best = k; }
  }
  return best;
}

export interface VideoFixture {
  video: string;
  fps: number;
  /** The character area (below the counter band). */
  crop: { x: number; y: number; width: number; height: number };
  answers: {
    speedChangeAt: number; cutAt: number; transition: [number, number]; onesFrom: number;
    stutterNear: number; dropNear: number; flashAt: number; blackAt: number; clickAt: number; frames: number;
  };
}

const W = 320, BAND = 60, H = 400;
const FONT = ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"].find((f) => existsSync(f));

export async function buildVideoFixture(config: Config, cli: SpineCli, root: string): Promise<VideoFixture> {
  const bolt = join(process.cwd(), "demo", "bolt", "bolt.spine");
  const hop = (await renderFrames(config, cli, bolt, { skeleton: "bolt", animation: "hop", fps: 30, scale: 50, background: "7f7f7fff" })).frames;
  const wave = (await renderFrames(config, cli, bolt, { skeleton: "bolt", animation: "wave", fps: 30, scale: 50, background: "3050a0ff" })).frames;
  const idle = (await renderFrames(config, cli, bolt, { skeleton: "bolt", animation: "idle", fps: 60, scale: 50, background: "7f7f7fff" })).frames;
  // Each output frame: a source image (or a blend / colour) under a counter band.
  type Src = { file?: string; blend?: [string, string, number]; colour?: string };
  const seq: Src[] = [];
  // A: hop on twos, one image held 3 frames (stutter).
  hop.forEach((f, i) => { seq.push({ file: f }, { file: f }); if (i === 10) seq.push({ file: f }); });
  const stutterNear = 2 * 11 + 1;
  // B: the same slowed to 0.25x (each image held 8 frames), no cut.
  const speedChangeAt = seq.length;
  hop.forEach((f) => { for (let r = 0; r < 8; r++) seq.push({ file: f }); });
  // C: hard cut to wave on blue, on twos.
  const cutAt = seq.length;
  wave.forEach((f) => seq.push({ file: f }, { file: f }));
  // D: 12-frame crossfade into idle.
  const tFrom = seq.length;
  for (let i = 1; i <= 12; i++) seq.push({ blend: [wave[wave.length - 1]!, idle[0]!, i / 13] });
  const tTo = seq.length - 1;
  // E: hop on ones (rendered at 60 fps) with one frame removed in the middle of the fast rise (a doubled step).
  const hop60 = (await renderFrames(config, cli, bolt, { skeleton: "bolt", animation: "hop", fps: 60, scale: 50, background: "7f7f7fff" })).frames;
  // A fixture built from an incomplete render gives wrong answers, not an error (seen once under a full parallel run):
  // every frame must be a whole PNG, and the 60 fps hop twice the 30 fps one.
  for (const f of [...hop, ...wave, ...idle, ...hop60]) {
    const png = readFileSync(f);
    if (png.length < 64 || png.subarray(-8, -4).toString() !== "IEND") throw new Error(`video fixture: incomplete render frame ${f} (${png.length} bytes)`);
  }
  if (Math.abs(hop60.length - 2 * hop.length) > 2) throw new Error(`video fixture: hop rendered ${hop.length} frames at 30 fps and ${hop60.length} at 60 fps`);
  const onesFrom = seq.length;
  const dropIndex = fastestStep(hop60);
  hop60.forEach((f, i) => { if (i !== dropIndex) seq.push({ file: f }); });
  hop60.forEach((f) => seq.push({ file: f }));
  const dropNear = onesFrom + dropIndex;
  // F: a white flash (2 frames), hop again, one black frame, hop again.
  const flashAt = seq.length;
  // The same animation carries on around the flash and the black frame (no content change hidden under them).
  seq.push({ colour: "#ffffff" }, { colour: "#ffffff" });
  hop60.slice(0, 40).forEach((f) => seq.push({ file: f }));
  const blackAt = seq.length;
  seq.push({ colour: "#000000" });
  hop60.slice(40).forEach((f) => seq.push({ file: f }));

  const dir = join(root, "fixture-frames");
  mkdirSync(dir, { recursive: true });
  const font = FONT ? ["-font", FONT] : [];
  for (let c = 0; c < seq.length; c += 40) {
    const args: string[] = [];
    seq.slice(c, c + 40).forEach((s, i) => {
      const k = c + i, out = join(dir, `f_${String(k).padStart(5, "0")}.png`);
      const body = s.colour ? ["-size", `${W}x${H}`, `xc:${s.colour}`]
        : s.blend ? ["(", s.blend[0], "-resize", `${W}x${H}!`, ")", "(", s.blend[1], "-resize", `${W}x${H}!`, ")", "-compose", "blend", "-define", `compose:args=${Math.round(s.blend[2] * 100)}`, "-composite"]
        : [s.file!, "-resize", `${W}x${H}!`];
      args.push("(", ...body, "-background", "#202030", "-gravity", "north", "-splice", `0x${BAND}`, ...font, "-fill", "white", "-pointsize", "28", "-annotate", "+0+14", String(k).padStart(4, "0"), "-write", out, ")", "+delete");
    });
    args.push("-size", "1x1", "xc:none", "null:");
    execFileSync("magick", args);
  }
  const fps = 60, clickAt = flashAt;
  const click = join(root, "click.wav");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=1000:duration=0.05`, "-af", `adelay=${Math.round((clickAt / fps) * 1000)}|${Math.round((clickAt / fps) * 1000)},apad=whole_dur=${(seq.length / fps).toFixed(3)}`, click]);
  const video = join(root, "fixture.mp4");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(dir, "f_%05d.png"), "-i", click, "-c:v", "libx264", "-crf", "28", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
  writeFileSync(join(root, "fixture.json"), JSON.stringify({ speedChangeAt, cutAt, tFrom, tTo }));
  return {
    video, fps, crop: { x: 0, y: BAND, width: W, height: H },
    answers: { speedChangeAt, cutAt, transition: [tFrom, tTo], onesFrom, stutterNear, dropNear, flashAt, blackAt, clickAt, frames: seq.length },
  };
}
