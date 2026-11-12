#!/usr/bin/env node
// Builds the README videos. Each composition file gets a throwaway project folder (.work/<name>) with the shared kit
// and a link to assets/, so HyperFrames can check and render it as its own index.html.
//   node build.mjs sync                         # copy generated media (.lab/feature-media) into assets/gen
//   node build.mjs check [names]                # hyperframes check
//   node build.mjs snap <name> <t1,t2,...>      # stills into .work/<name>/snaps
//   node build.mjs render [names]               # renders/<name>.mp4
//   node build.mjs publish [names]              # docs/media: <name>.mp4, <name>.webp (inline loop), <name>.jpg (poster)
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const HF = ["--yes", "hyperframes@0.8.166"];
/** name: [composition file, poster time (s), inline loop: [start, seconds]] */
const VIDEOS = {
  launch: ["index.html", 20.2, [10.8, 3.0]],
  rig: ["feature-rig.html", 13.8, [11.6, 3.0]],
  animate: ["feature-animate.html", 13.6, [6.0, 4.0]],
  derive: ["feature-derive.html", 10.6, [5.1, 2.6]],
  review: ["feature-review.html", 10.6, [7.5, 4.4]],
  safety: ["feature-safety.html", 10.8, [7.7, 4.1]],
  ship: ["feature-ship.html", 11.0, [7.8, 4.2]],
  faces: ["feature-face.html", 5.8, [3.6, 4.4]],
  game: ["feature-game.html", 6.0, [3.4, 4.4]],
  parts: ["feature-parts.html", 14.8, [13.2, 3.6]],
  production: ["feature-production.html", 10.4, [8.6, 3.6]],
};
const [cmd, ...rest] = process.argv.slice(2);
const names = (list) => (list?.length ? list : Object.keys(VIDEOS)).filter((n) => existsSync(join(here, VIDEOS[n][0])));
const run = (bin, args, cwd = here) => execFileSync(bin, args, { cwd, stdio: "inherit" });

function prepare(name) {
  const dir = join(here, ".work", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(here, VIDEOS[name][0]), join(dir, "index.html"));
  for (const f of ["kit.css", "kit.js", "hyperframes.json", "meta.json", "package.json"]) copyFileSync(join(here, f), join(dir, f));
  symlinkSync("../../assets", join(dir, "assets"));
  return dir;
}

if (cmd === "sync") {
  const src = join(repo, ".lab", "feature-media");
  const gen = join(here, "assets", "gen");
  mkdirSync(gen, { recursive: true });
  for (const sub of ["img", "clips"]) if (existsSync(join(src, sub))) cpSync(join(src, sub), gen, { recursive: true });
  console.log(readdirSync(gen).join("\n"));
} else if (cmd === "check") {
  for (const n of names(rest)) { console.log(`\n== ${n}`); run("npx", [...HF, "check", prepare(n)]); }
} else if (cmd === "snap") {
  const [n, at] = rest;
  const dir = prepare(n);
  run("npx", [...HF, "snapshot", dir, "--at", at, "--no-end", "-o", join(dir, "snaps")]);
} else if (cmd === "render") {
  mkdirSync(join(here, "renders"), { recursive: true });
  for (const n of names(rest)) run("npx", [...HF, "render", prepare(n), "-o", join(here, "renders", `${n}.mp4`), "--quality", "delivery"]);
} else if (cmd === "publish") {
  const media = join(repo, "docs", "media");
  for (const n of names(rest)) {
    const [, poster, [from, secs]] = VIDEOS[n];
    const src = join(here, "renders", `${n}.mp4`);
    const tmp = join(here, ".work", `${n}-publish`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    // Poster: the strongest settled frame, also baked in as frame 0 (thumbnail everywhere), duration and audio unchanged.
    run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(poster), "-i", src, "-frames:v", "1", "-q:v", "3", join(media, `spine-mcp-${n}.jpg`)]);
    run("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-i", join(media, `spine-mcp-${n}.jpg`), "-filter_complex",
      "[1:v]scale=1920:1080,setsar=1[p];[0:v][p]overlay=enable='eq(n,0)'[v]", "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-crf", "26", "-preset", "slow",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", join(media, `spine-mcp-${n}.mp4`)]);
    // Inline loop for the README: the key highlight, small.
    run("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(from), "-t", String(secs), "-i", src, "-vf", "fps=12,scale=720:-1:flags=lanczos", join(tmp, "f%04d.png")]);
    const frames = readdirSync(tmp).filter((f) => f.endsWith(".png")).sort().map((f) => join(tmp, f));
    run("img2webp", ["-loop", "0", "-lossy", "-q", "62", "-m", "6", "-d", String(Math.round(1000 / 12)), ...frames, "-o", join(media, `spine-mcp-${n}.webp`)]);
    rmSync(tmp, { recursive: true, force: true });
    run("ls", ["-la", join(media, `spine-mcp-${n}.mp4`), join(media, `spine-mcp-${n}.webp`), join(media, `spine-mcp-${n}.jpg`)]);
  }
} else {
  console.log("usage: node build.mjs sync | check [names] | snap <name> <times> | render [names] | publish [names]");
}
