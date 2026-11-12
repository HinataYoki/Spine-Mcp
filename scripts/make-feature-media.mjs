#!/usr/bin/env node
// Media for the README videos: every clip, image and number comes from the real spine-mcp server over stdio
// (the same calls an agent makes), on the Bolt demo character and on Bolt rebuilt from a layered PSD.
// Output: .lab/feature-media/ (git-ignored): clips/*.mp4 (Spine renders on a light background, one shared canvas per
// section), img/*.png (tool images), outputs/*.json (tool results) and facts.json (the numbers the videos show).
//
// Usage (outside the Claude Code sandbox; needs Spine Pro, ffmpeg, ImageMagick; Unity/Chrome for `ship`):
//   npm run build && node scripts/make-feature-media.mjs [--only rig,animate,derive,face,game,review,safety,ship,parts,production]
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PNG } from "pngjs";
import { rasterizeSvg } from "../dist/spine/svgraster.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repo); // the PSD fixture reads DFY/images relative to the cwd
const { plainPsd, POS, writePsd } = await import("../tests/psd-fixture.ts");

const only = (() => { const i = process.argv.indexOf("--only"); return i > 0 ? process.argv[i + 1].split(",") : null; })();
const want = (s) => !only || only.includes(s);
const OUT = join(repo, ".lab", "feature-media");
for (const d of ["clips", "img", "outputs", "frames"]) mkdirSync(join(OUT, d), { recursive: true });
const factsFile = join(OUT, "facts.json");
const facts = existsSync(factsFile) ? JSON.parse(readFileSync(factsFile, "utf8")) : {};
const saveFacts = () => writeFileSync(factsFile, JSON.stringify(facts, null, 2));

const root = mkdtempSync(join(tmpdir(), "spine-mcp-feature-media-"));
const client = new Client({ name: "make-feature-media", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, "dist/index.js")], env: { ...process.env, SPINE_MCP_WORKDIR: join(root, "work") } }));

/** One tool call; images are saved as img/<save>[-n].png and the JSON result as outputs/<save>.json. */
async function call(name, args, save) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 1_800_000 });
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  if (r.isError) throw new Error(`${name}: ${text}`);
  let value;
  try { value = JSON.parse(text); } catch { value = text; }
  if (save) {
    r.content.filter((c) => c.type === "image").forEach((img, i) => writeFileSync(join(OUT, "img", `${save}${i ? `-${i + 1}` : ""}.png`), Buffer.from(img.data, "base64")));
    writeFileSync(join(OUT, "outputs", `${save}.json`), JSON.stringify(value, null, 2));
  }
  console.log(`${name.padEnd(26)} ${String(Date.now() - t0).padStart(7)} ms  ${save ?? ""}`);
  return value;
}

const sh = (bin, args) => execFileSync(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
const pngSize = (f) => { const p = PNG.sync.read(readFileSync(f)); return [p.width, p.height]; };
const even = (n) => n + (n % 2);

/** Renders an animation with Spine and keeps its frames under frames/<name>. */
async function renderClip(project, animation, name, scale = 100, { skin, crop } = {}) {
  const r = await call("spine_render_frames", { project, animation, fps: 30, scale, maxFrames: 4, cell: 128, ...(skin ? { skin } : {}) });
  const dir = join(OUT, "frames", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  readdirSync(r.dir).filter((f) => /^frame.*\.png$/.test(f)).sort().forEach((f, i) => {
    const out = join(dir, `${String(i).padStart(4, "0")}.png`);
    // crop: [x, y, w, h] as fractions of the frame (a face close-up), the same box for every frame of the clip.
    if (crop) { const [w, h] = pngSize(join(r.dir, f)); sh("magick", [join(r.dir, f), "-crop", `${Math.round(w * crop[2])}x${Math.round(h * crop[3])}+${Math.round(w * crop[0])}+${Math.round(h * crop[1])}`, "+repage", out]); }
    else copyFileSync(join(r.dir, f), out);
  });
  return dir;
}

/**
 * Encodes clips on one shared canvas (largest frame of the set, feet on the bottom edge, centered) so a character
 * keeps the same size from card to card; each clip loops to `seconds`.
 */
function encodeClips(names, { seconds = 8, bg = "F2F3FE" } = {}) {
  const sizes = names.map((n) => pngSize(join(OUT, "frames", n, "0000.png")));
  const W = even(Math.max(...sizes.map((s) => s[0])) + 40), H = even(Math.max(...sizes.map((s) => s[1])) + 30);
  for (const n of names) {
    const dir = join(OUT, "frames", n);
    const frames = readdirSync(dir).filter((f) => /^\d{4}\.png$/.test(f)).sort();
    const loop = join(root, `loop-${n}`);
    rmSync(loop, { recursive: true, force: true });
    mkdirSync(loop);
    for (let i = 0; i < seconds * 30; i++) copyFileSync(join(dir, frames[i % frames.length]), join(loop, `${String(i).padStart(5, "0")}.png`));
    sh("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=0x${bg}:s=${W}x${H}:r=30`, "-framerate", "30", "-i", join(loop, "%05d.png"),
      "-filter_complex", "[1:v]format=rgba[f];[0:v][f]overlay=(W-w)/2:H-h-15:shortest=1,format=yuv420p", "-c:v", "libx264", "-crf", "20", "-preset", "slow", "-movflags", "+faststart", join(OUT, "clips", `${n}.mp4`)]);
    rmSync(loop, { recursive: true, force: true });
  }
  return { width: W, height: H };
}

const keep = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

// ---------- fixtures ----------
const boltDir = join(root, "bolt");
cpSync(join(repo, "DFY"), boltDir, { recursive: true });
const bolt = join(boltDir, "bolt.spine");
mkdirSync(join(root, "psd"), { recursive: true });
const psd = writePsd(plainPsd(), join(root, "psd", "bolt.psd"));
const rigDir = join(root, "rig");
mkdirSync(rigDir, { recursive: true });
const rig = join(rigDir, "bolt.spine");
let rigBuilt = false;

async function buildRig() {
  if (rigBuilt) return;
  const sug = await call("spine_auto_rig", { psd, output: rig }, "rig-suggest");
  const built = await call("spine_auto_rig", { psd, output: rig, bones: sug.suggestions.bones, ik: sug.suggestions.ik, apply: true }, "rig-apply");
  rigBuilt = true;
  return { sug, built };
}

// ---------- rig: a layered PSD into a project, then a starting rig ----------
if (want("rig")) {
  mkdirSync(join(root, "imported"), { recursive: true });
  const imported = await call("spine_import_layers", { psd, output: join(root, "imported", "bolt.spine"), apply: true, targetHeight: 280 }, "import-layers");
  const { sug, built } = await buildRig();
  const counts = (b) => ({ bones: b.bones?.length, ik: b.ik?.length, slots: b.slots?.length });
  facts.rig = {
    psd: { layers: imported.psd?.layers, groups: imported.psd?.groups, width: imported.psd?.width, height: imported.psd?.height },
    imported: keep(imported, ["mode", "skeleton", "images", "verification", "setupOverlap", "overlap", "check"]),
    importedRaw: Object.keys(imported),
    artQa: imported.artQa,
    suggested: { bones: sug.suggestions.bones.length, ik: sug.suggestions.ik?.length ?? 0, names: sug.suggestions.bones.map((b) => b.name) },
    built: { ...counts(built), keys: Object.keys(built) },
  };
  saveFacts();
}

// ---------- animate: generated animations on the PSD-built rig ----------
if (want("animate")) {
  await buildRig();
  // Walk and run facing the camera (Bolt is drawn from the front): feet lift in turn, knees out, arms through their IK.
  const walkSug = await call("spine_generate_animation", { project: rig, type: "walk" }, "walk-suggest");
  const s = walkSug.suggestions;
  const walkArgs = { legs: s.legs.slice(0, 2), hip: s.hip, arms: (s.arms ?? []).map((bone) => ({ bone })), view: "front" };
  const gen = {};
  gen.walk = await call("spine_generate_animation", { project: rig, type: "walk", name: "walk", walk: { ...walkArgs, style: "walk" }, apply: true }, "gen-walk");
  gen.run = await call("spine_generate_animation", { project: rig, type: "walk", name: "run", walk: { ...walkArgs, style: "run" }, apply: true }, "gen-run");
  // A hop with anticipation, take-off, air (feet tucked through their IK targets, arms up), landing and recovery:
  // blocked as key poses, then smoothed by the spline pass.
  const T = (k) => Object.fromEntries(k.map(([t, x, y]) => [t, { x, y }]));
  const keys = (m) => Object.entries(m).map(([t, v]) => ({ ...(+t ? { time: +t } : {}), x: v.x, y: v.y }));
  const hopRaw = {
    bones: {
      torso: { translate: keys(T([[0, 0, 0], [0.18, 0, -20], [0.32, 0, 40], [0.48, 0, 92], [0.64, 0, 40], [0.76, 0, -16], [0.92, 0, 3], [1.1, 0, 0]])) },
      "shin-target": { translate: keys(T([[0, 0, 0], [0.18, 0, 0], [0.32, 0, 44], [0.48, 6, 112], [0.64, 0, 48], [0.76, 0, 0], [1.1, 0, 0]])) },
      "shin-back-target": { translate: keys(T([[0, 0, 0], [0.18, 0, 0], [0.32, 0, 44], [0.48, -6, 112], [0.64, 0, 48], [0.76, 0, 0], [1.1, 0, 0]])) },
      "lower-arm-target": { translate: keys(T([[0, 0, 0], [0.18, 6, -14], [0.32, 14, 70], [0.48, 22, 120], [0.64, 12, 70], [0.76, 8, -18], [0.92, 0, -4], [1.1, 0, 0]])) },
      "lower-arm-back-target": { translate: keys(T([[0, 0, 0], [0.18, -6, -14], [0.32, -14, 70], [0.48, -22, 120], [0.64, -12, 70], [0.76, -8, -18], [0.92, 0, -4], [1.1, 0, 0]])) },
      // Bolt faces the camera: a 2D knee can only go sideways, so the legs foreshorten instead (bend toward the camera),
      // as the front-view walk does: each thigh is scaled to the hip-to-foot distance over its setup distance (135.6;
      // the shins inherit the scale). In the crouch and the landing the hip comes down; in the air the feet tuck up
      // past the hip's rise. A leg stretched past its drawn length would bend its drawing the other way at the knee.
      ...Object.fromEntries(["thigh", "thigh-back"].map((b) => [b, { scale: keys(T([[0, 1, 1], [0.18, 0.853, 1], [0.32, 0.97, 1], [0.48, 0.853, 1], [0.64, 0.941, 1], [0.76, 0.882, 1], [0.92, 1, 1], [1.1, 1, 1]])) }])),
    },
    // No IK bend keys: the knees keep the rig's own bend, so the legs keep the shape they are drawn in.
  };
  await call("spine_add_animation", { project: rig, name: "hop-blocked", animation: hopRaw, apply: true }, "anim-hop-blocked");
  gen.hop = await call("spine_derive_animation", { project: rig, source: "hop-blocked", name: "hop", ops: [{ op: "spline" }], apply: true }, "gen-hop");
  gen.turn = await call("spine_generate_animation", { project: rig, type: "turn", name: "turn", turn: { face: ["head"], poses: [{ time: 0.4, yaw: 28 }, { time: 1.4, yaw: -28 }], duration: 2 }, apply: true }, "gen-turn");
  gen.squash = await call("spine_generate_animation", { project: rig, type: "squash", name: "hop-squash", squash: { slots: ["torso", "head"], source: "hop", bone: "torso" }, apply: true }, "gen-squash");
  gen.breathe = await call("spine_generate_animation", { project: rig, type: "breathe", name: "breathe", breathe: { torso: ["torso"], followers: ["head", "upper-arm", "upper-arm-back"], amount: 0.04 }, apply: true }, "gen-breathe");
  gen.look = await call("spine_generate_animation", { project: rig, type: "lookAt", name: "look", lookAt: { bones: ["torso", "head"], looks: [{ time: 0.5, angle: 14 }, { time: 1.7, angle: -10 }], duration: 3 }, apply: true }, "gen-look");
  // An upright antenna does not swing on a vertical hop (it is accelerated along its axis); it trails a turn of the head.
  gen.follow = await call("spine_generate_animation", { project: rig, type: "followThrough", name: "look-follow", followThrough: { source: "look", bones: ["antenna"], strength: 200, damping: 0.9, inertia: 0.5 }, apply: true }, "gen-follow");
  const poses = [{ time: 0, pose: "hop@0" }, { time: 0.35, pose: "hop@0.18" }, { time: 0.7, pose: "hop@0.48" }, { time: 1.05, pose: "hop@0.76" }, { time: 1.4, pose: "hop@0" }];
  gen.blocking = await call("spine_generate_animation", { project: rig, type: "blocking", name: "blocking", blocking: { poses, duration: 1.4 }, apply: true }, "gen-blocking");
  gen.spline = await call("spine_generate_animation", { project: rig, type: "blocking", name: "blocking-spline", blocking: { poses, duration: 1.4, spline: true }, apply: true }, "gen-spline");
  const names = ["walk", "run", "turn", "hop", "hop-squash", "breathe", "look", "look-follow", "blocking", "blocking-spline"];
  for (const n of names) await renderClip(rig, n, `gen-${n}`, 120);
  const canvas = encodeClips(names.map((n) => `gen-${n}`));
  facts.animate = {
    canvas,
    results: Object.fromEntries(Object.entries(gen).map(([k, v]) => [k, { mode: v.mode, name: v.name, summary: keep(v.summary, ["duration", "keys"]), notes: v.generateNotes, verification: v.verification, issues: v.issues?.length }])),
  };
  saveFacts();
}

// ---------- derive: variants of the hand-built Bolt's animations ----------
const pairs = [["upper-arm", "upper-arm-back"], ["lower-arm", "lower-arm-back"], ["thigh", "thigh-back"], ["shin", "shin-back"]];
let derived = false;
async function deriveAll() {
  if (derived) return;
  const d = {};
  d.mirror = await call("spine_derive_animation", { project: bolt, source: "wave", name: "wave-mirrored", ops: [{ op: "mirror", pairs }], apply: true }, "derive-mirror");
  d.big = await call("spine_derive_animation", { project: bolt, source: "hop", name: "hop-big", ops: [{ op: "scaleValues", factor: 1.3, kinds: ["rotate"] }, { op: "retime", factor: 1.2 }], apply: true }, "derive-big");
  d.overlap = await call("spine_derive_animation", { project: bolt, source: "wave", name: "wave-overlap", ops: [{ op: "offsetBones", bones: ["lower-arm"], seconds: 0.1 }, { op: "offsetBones", bones: ["head"], seconds: 0.15 }], apply: true }, "derive-overlap");
  d.baked = await call("spine_derive_animation", { project: bolt, source: "hop", name: "hop-baked", ops: [{ op: "bakePhysics", cycles: "auto" }], apply: true }, "derive-baked");
  derived = true;
  return d;
}
if (want("derive")) {
  const d = await deriveAll();
  const cmp = await call("spine_compare_animations", { input: bolt, a: "hop", b: "hop-big", bones: ["hip", "upper-arm", "head"] }, "compare-hop");
  const names = ["wave", "wave-mirrored", "hop", "hop-big", "wave-overlap", "hop-baked"];
  for (const n of names) await renderClip(bolt, n, `der-${n}`, 90);
  const canvas = encodeClips(names.map((n) => `der-${n}`));
  facts.derive = {
    canvas,
    results: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { mode: v.mode, name: v.name, summary: keep(v.summary, ["duration", "keys"]), deriveNotes: v.deriveNotes, verification: v.verification, backup: v.backup?.id }])),
    compare: keep(cmp, ["duration", "motionRatio", "overall", "timing", "bones"]),
  };
  saveFacts();
}

// ---------- face: blinks from the artist's own shut pose, blinks over head moves, eye darts (mix-and-match, Esoteric) ----------
if (want("face")) {
  const src = join(repo, ".lab", "fixtures", "mix-and-match");
  if (!existsSync(join(src, "mix-and-match-pro.spine"))) throw new Error("face needs .lab/fixtures/mix-and-match (Esoteric's example: project + images)");
  const mmDir = join(root, "mix-and-match");
  cpSync(src, mmDir, { recursive: true });
  const mm = join(mmDir, "mix-and-match-pro.spine");
  const skin = "full-skins/girl";
  const lidBones = ["eye-front-up-eyelid-holder", "eye-front-up-eyelid", "eye-front-low-eyelid-holder", "eye-front-low-eyelid", "eye-front-eyebrow", "eye-back-up-eyelid-holder", "eye-back-up-eyelid", "eye-back-low-eyelid-holder", "eye-back-low-eyelid", "eye-back-eyebrow"];
  const eyeSlots = ["eye-front-white", "eye-front-iris", "eye-front-pupil", "eye-back-white", "eye-back-iris", "eye-back-pupil"];
  const f = {};
  f.blink = await call("spine_generate_animation", { project: mm, type: "blink", name: "blink-mcp", blink: { lids: lidBones.map((bone) => ({ bone, closedFrom: "blink@0.045" })), hide: eyeSlots, duration: 1.2, blinks: [{ time: 0.3 }] }, apply: true, allowUpgrade: true }, "face-blink");
  f.onPoses = await call("spine_generate_animation", { project: mm, type: "blink", name: "aware-blinks", blink: { lids: lidBones.map((bone) => ({ bone, closedFrom: "blink@0.045" })), hide: eyeSlots, onPoses: { source: "aware", bones: ["head", "head-control"], minGap: 0.4 } }, apply: true, allowUpgrade: true }, "face-onposes");
  // Played together (blink on a track over aware) as one animation, so Spine can render it.
  const exp = await call("spine_export_json", { project: mm });
  const doc = JSON.parse(readFileSync(exp.skeletons[0].json, "utf8"));
  const aware = doc.animations.aware, blinks = doc.animations["aware-blinks"];
  const together = { ...aware, bones: { ...aware.bones, ...blinks.bones }, slots: { ...(aware.slots ?? {}), ...(blinks.slots ?? {}) } };
  f.together = await call("spine_add_animation", { project: mm, name: "aware-with-blinks", animation: together, apply: true, allowUpgrade: true }, "face-together");
  f.gaze = await call("spine_generate_animation", { project: mm, type: "gaze", name: "gaze", gaze: { bones: ["eye-front-pupil", "eye-back-pupil"], duration: 4, count: 5, seed: 3 }, apply: true, allowUpgrade: true }, "face-gaze");
  f.validate = await call("spine_validate", { input: mm }, "face-validate");
  const face = [0.38, 0.22, 0.42, 0.18];
  for (const [anim, name, crop] of [["blink", "face-artist-blink", face], ["blink-mcp", "face-mcp-blink", face], ["aware", "face-aware", null], ["aware-with-blinks", "face-aware-blinks", null], ["gaze", "face-gaze", face]]) await renderClip(mm, anim, name, crop ? 160 : 60, { skin, crop });
  facts.face = { canvas: encodeClips(["face-artist-blink", "face-mcp-blink", "face-gaze"]), canvasBody: encodeClips(["face-aware", "face-aware-blinks"]), results: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { mode: v.mode, name: v.name, notes: v.generateNotes, verification: v.verification, issues: v.issues }])) };
  saveFacts();
}

/** A line chart (series of [x, y]) as PNG, drawn through svgraster (ImageMagick MVG). */
function lineChart(file, { width = 900, height = 360, series, title, xLabel, yLabel, marks = [] }) {
  const all = series.flatMap((s) => s.points);
  const x0 = Math.min(...all.map((p) => p[0])), x1 = Math.max(...all.map((p) => p[0]));
  const y0 = Math.min(...all.map((p) => p[1])), y1 = Math.max(...all.map((p) => p[1]));
  const L = 70, R = 20, T = 40, B = 46, w = width - L - R, h = height - T - B;
  const X = (x) => L + ((x - x0) / (x1 - x0 || 1)) * w, Y = (y) => T + h - ((y - y0) / (y1 - y0 || 1)) * h;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#ffffff"/>`];
  parts.push(`<text x="${L}" y="24" font-size="15" fill="#222">${title}</text>`);
  parts.push(`<line x1="${L}" y1="${T + h}" x2="${L + w}" y2="${T + h}" stroke="#999"/><line x1="${L}" y1="${T}" x2="${L}" y2="${T + h}" stroke="#999"/>`);
  parts.push(`<text x="${L + w - 150}" y="${T + h + 18}" font-size="12" fill="#555">${xLabel}</text><text x="8" y="${T + 10}" font-size="12" fill="#555">${yLabel}</text>`);
  for (const m of marks) parts.push(`<line x1="${X(m.x)}" y1="${T}" x2="${X(m.x)}" y2="${T + h}" stroke="#bbbbbb" stroke-dasharray="4,4"/><text x="${X(m.x) + 4}" y="${T + 14}" font-size="12" fill="#777">${m.label}</text>`);
  series.forEach((s, si) => {
    for (let i = 1; i < s.points.length; i++) parts.push(`<line x1="${X(s.points[i - 1][0]).toFixed(1)}" y1="${Y(s.points[i - 1][1]).toFixed(1)}" x2="${X(s.points[i][0]).toFixed(1)}" y2="${Y(s.points[i][1]).toFixed(1)}" stroke="${s.color}" stroke-width="${s.width ?? 2.5}"/>`);
  });
  series.forEach((s, si) => parts.push(`<line x1="${L + 10 + si * 270}" y1="${height - 16}" x2="${L + 34 + si * 270}" y2="${height - 16}" stroke="${s.color}" stroke-width="4"/><text x="${L + 40 + si * 270}" y="${height - 12}" font-size="12" fill="#333">${s.label}</text>`));
  parts.push("</svg>");
  rasterizeSvg(parts.join(""), join(root, `${Date.now()}.mvg`), file);
}

// ---------- game: SkeletonMecanim, lost events, layered tracks, UI, draw calls, texture memory, upgrade audit, merging, root motion ----------
if (want("game")) {
  const boy = join(root, "spineboy", "spineboy-pro.spine");
  cpSync(join(repo, ".lab", "fixtures", "spineboy"), join(root, "spineboy"), { recursive: true });
  const g = {};
  // Mecanim: hop -> idle on Bolt, the antenna tip traced in Unity, before and after setupKeys (a copy keeps the keys).
  const tr = [{ from: "hop", to: "idle", at: 0.5, duration: 0.25, trace: "antenna-tip" }];
  g.mecBefore = await call("spine_unity_check", { project: bolt, mecanimTransitions: tr }, "game-mecanim-before");
  const fixedDir = join(root, "bolt-setupkeys");
  cpSync(join(repo, "DFY"), fixedDir, { recursive: true });
  const fixed = join(fixedDir, "bolt.spine");
  g.setupKeys = await call("spine_derive_animation", { project: fixed, source: "idle", name: "idle", ops: [{ op: "setupKeys" }], apply: true, replace: true }, "game-setupkeys");
  g.mecAfter = await call("spine_unity_check", { project: fixed, mecanimTransitions: tr }, "game-mecanim-after");
  g.mixState = await call("spine_mix_check", { input: bolt, transitions: [{ from: "hop", to: "idle", mix: 0.25 }], at: [0.5], trace: "antenna-tip" }, "game-mix-state");
  g.mixMecanim = await call("spine_mix_check", { input: bolt, transitions: [{ from: "hop", to: "idle", mix: 0.25 }], at: [0.5], trace: "antenna-tip", runtime: "mecanim" }, "game-mix-mecanim");
  const ys = (pts, fps, offset) => pts.map((p, i) => [+((i - offset) / fps).toFixed(4), p[1]]);
  const before = g.mecBefore.mecanim[0].trace, after = g.mecAfter.mecanim[0].trace, st = g.mixState.traces[0];
  lineChart(join(OUT, "img", "game-mecanim.png"), {
    title: "Bolt hop -> idle, 0.25 s transition: antenna tip height, frame by frame",
    xLabel: "seconds after the switch", yLabel: "units",
    series: [
      { label: "SkeletonMecanim in Unity", color: "#e4572e", points: ys(before.unity, before.fps, 2) },
      { label: "after setupKeys (Unity)", color: "#2e86ab", points: ys(after.unity, after.fps, 2) },
      { label: "AnimationState (spine-core)", color: "#7b8794", points: ys(st.points, st.fps, st.switchFrame).filter((p) => p[0] <= ys(before.unity, before.fps, 2).at(-1)[0]), width: 1.5 },
    ],
    marks: [{ x: 0, label: "switch" }, { x: 0.25, label: "transition ends" }],
  });
  // Events inside the mix: spineboy's footsteps.
  g.events = await call("spine_mix_check", { input: boy, transitions: [{ from: "walk", to: "idle" }, { from: "run", to: "idle" }, { from: "walk", to: "run" }], defaultMix: 0.2 }, "game-events");
  g.eventsFixed = await call("spine_mix_check", { input: boy, transitions: [{ from: "walk", to: "idle" }, { from: "run", to: "idle" }, { from: "walk", to: "run" }], defaultMix: 0.2, eventThreshold: 0.5 }, "game-events-fixed");
  // Layered tracks, UI render and draw calls in Unity.
  g.tracks = await call("spine_unity_check", { project: boy, tracks: ["walk", "aim"], tracksSeconds: 6, batching: true, render: true, renderComponent: "graphic", renderAnimations: ["walk", "shoot"] }, "game-unity");
  g.budget = await call("spine_budget", { input: boy }, "game-budget");
  // Texture memory: packings ranked.
  g.sweep = await call("spine_export", { project: boy, sweep: { maxSize: [1024, 2048], pot: [false, true], packing: ["polygons", "rectangles"] } }, "game-sweep");
  // Root motion readiness.
  g.rootMotion = await call("spine_measure", { input: boy, animation: "walk", rootMotion: { feet: ["front-foot", "rear-foot"] } }, "game-rootmotion");
  // Upgrade audit on a demo Unity project folder: Bolt exported for 4.3, one file marked as a 4.2 export, a script on 4.2 APIs.
  const demo = join(root, "unity-demo");
  for (const d of ["ProjectSettings", "Packages", "Assets/Characters/bolt", "Assets/Characters/bolt-old", "Assets/Scripts"]) mkdirSync(join(demo, d), { recursive: true });
  writeFileSync(join(demo, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 2022.3.62f3\n");
  writeFileSync(join(demo, "Packages", "manifest.json"), JSON.stringify({ dependencies: { "com.esotericsoftware.spine.spine-unity": "4.3.115" } }));
  await call("spine_export", { project: bolt, outputDir: join(demo, "Assets", "Characters", "bolt"), format: "binary", premultipliedAlpha: true });
  await call("spine_export", { project: bolt, outputDir: join(demo, "Assets", "Characters", "bolt-old"), format: "json" });
  const oldJson = join(demo, "Assets", "Characters", "bolt-old", "bolt.json");
  writeFileSync(oldJson, readFileSync(oldJson, "utf8").replace(/"spine":"4\.3\.\d+"/, '"spine":"4.2.43"'));
  for (const f of readdirSync(join(demo, "Assets", "Characters", "bolt"))) if (f.endsWith(".skel")) { copyFileSync(join(demo, "Assets", "Characters", "bolt", f), join(demo, "Assets", "Characters", "bolt", `${f}.bytes`)); rmSync(join(demo, "Assets", "Characters", "bolt", f)); }
  for (const dir of ["bolt", "bolt-old"]) for (const f of readdirSync(join(demo, "Assets", "Characters", dir))) if (f.endsWith(".atlas")) { copyFileSync(join(demo, "Assets", "Characters", dir, f), join(demo, "Assets", "Characters", dir, `${f}.txt`)); rmSync(join(demo, "Assets", "Characters", dir, f)); }
  writeFileSync(join(demo, "Assets", "Scripts", "Hero.cs"), ["using Spine;", "using Spine.Unity;", "public class Hero : UnityEngine.MonoBehaviour {", "  public SkeletonAnimation anim;", "  void Respawn () {", "    anim.Skeleton.SetToSetupPose();", "    var current = anim.AnimationState.GetCurrent(0);", "    anim.Skeleton.UpdateWorldTransform(Skeleton.Physics.Update);", "  }", "}"].join("\n"));
  g.audit = await call("spine_unity_import", { unityProject: demo, audit: true, sources: [boltDir] }, "game-audit");
  // Merging two animators' copies of Bolt.
  const copy = (n) => { const d = join(root, `merge-${n}`); cpSync(join(repo, "DFY"), d, { recursive: true }); return join(d, "bolt.spine"); };
  const mBase = copy("base"), mA = copy("anna"), mB = copy("ben");
  await call("spine_derive_animation", { project: mA, source: "hop", name: "hop", ops: [{ op: "scaleValues", factor: 1.3 }], apply: true, replace: true });
  await call("spine_derive_animation", { project: mA, source: "wave", name: "wave-big", ops: [{ op: "scaleValues", factor: 1.2 }], apply: true });
  await call("spine_derive_animation", { project: mB, source: "hop", name: "hop", ops: [{ op: "retime", factor: 1.2 }], apply: true, replace: true });
  g.mergePlan = await call("spine_transfer_animation", { to: mBase, copies: [mA, mB] }, "game-merge-plan");
  g.merged = await call("spine_transfer_animation", { to: mBase, copies: [mA, mB], prefer: { hop: mB }, apply: true }, "game-merge-apply");
  // Pack sweep as bars.
  const rows = g.sweep.rows;
  const bw = 1000, bh = 60 + rows.length * 34, bars = [`<svg xmlns="http://www.w3.org/2000/svg" width="${bw}" height="${bh}"><rect width="${bw}" height="${bh}" fill="#ffffff"/><text x="20" y="28" font-size="15" fill="#222">spineboy atlas: texture memory per packing (RGBA32, MB)</text>`];
  const maxMB = Math.max(...rows.map((r) => r.rgba32MB));
  rows.forEach((r, i) => {
    const y = 50 + i * 34, len = (r.rgba32MB / maxMB) * 380;
    bars.push(`<text x="20" y="${y + 17}" font-size="13" fill="#333">${r.settings.maxSize} ${r.settings.pot ? "POT" : "free"} ${r.settings.packing}</text>`);
    bars.push(`<rect x="260" y="${y + 4}" width="${len.toFixed(1)}" height="20" fill="${i === 0 ? "#2e86ab" : "#c9d3e6"}"/>`);
    bars.push(`<text x="${(270 + len).toFixed(1)}" y="${y + 19}" font-size="13" fill="#333">${r.rgba32MB} MB, ${r.pages} page(s) ${r.sizes.join(" + ")}, ${Math.round(r.fill * 100)}% full</text>`);
  });
  bars.push("</svg>");
  rasterizeSvg(bars.join(""), join(root, "sweep.mvg"), join(OUT, "img", "game-sweep.png"));
  facts.game = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, Object.fromEntries(Object.entries(v ?? {}).filter(([, y]) => JSON.stringify(y ?? null).length < 6000))]));
  saveFacts();
}

// ---------- review: numbers and views an animation lead asks for ----------
if (want("review")) {
  await deriveAll();
  const r = {};
  r.mix = await call("spine_mix_check", { input: bolt, transitions: [{ from: "idle", to: "hop", mix: 0.2 }, { from: "hop", to: "wave", mix: 0.1 }, { from: "wave", to: "idle", mix: 0.2 }, { from: "hop-big", to: "idle", mix: 0 }] }, "review-mix");
  r.budget = await call("spine_budget", { input: bolt, limits: { drawCalls: 2, bones: 30 } }, "review-budget");
  r.timing = await call("spine_timing", { input: bolt, animation: "wave" }, "review-timing");
  r.measure = await call("spine_measure", { input: bolt, animation: "hop", limit: 5 }, "review-measure");
  r.motion = await call("spine_motion_visual", { project: bolt, animation: "wave", mode: "all", size: 900 }, "review-motion");
  r.video = await call("spine_review_video", { project: bolt, animations: ["hop", "wave"], output: join(OUT, "clips", "review.mp4"), overwrite: true, background: "#F2F3FE", scale: 100 }, "review-video");
  const ref = join(root, "reference.mp4");
  await call("spine_showcase", { project: bolt, items: [{ animation: "hop-big" }], output: ref, loops: 3, background: "#FFFFFF" }, "review-ref-showcase");
  copyFileSync(ref, join(OUT, "clips", "reference.mp4"));
  r.reference = await call("spine_reference_timing", { video: ref, compare: { project: bolt, animation: "hop" } }, "review-reference");
  r.inspect = await call("spine_video_inspect", { video: join(OUT, "clips", "review.mp4") }, "review-inspect");
  facts.review = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => JSON.stringify(x ?? null).length < 4000)) : v]));
  saveFacts();
}

// ---------- safety: dry-run, refusal, verified write, staging, status ----------
if (want("safety")) {
  const safeDir = join(root, "safe");
  cpSync(join(repo, "DFY"), safeDir, { recursive: true });
  const safe = join(safeDir, "bolt.spine");
  const nod = { bones: { head: { rotate: [{ value: 0 }, { time: 0.3, value: -8 }, { time: 0.6, value: 0 }] } } };
  const s = {};
  s.dry = await call("spine_add_animation", { project: safe, name: "nod", animation: nod }, "safe-dry");
  const bad = { bones: { tail: { rotate: [{ value: 0 }, { time: 0.4, value: 20 }] }, head: { rotate: [{ value: 0 }, { time: 0.4, value: 5 }] } } };
  s.badDry = await call("spine_add_animation", { project: safe, name: "tail-wag", animation: bad }, "safe-bad-dry");
  try { await call("spine_add_animation", { project: safe, name: "tail-wag", animation: bad, apply: true }); } catch (e) { s.badApply = e.message.replace(/^spine_add_animation: /, ""); }
  s.apply = await call("spine_add_animation", { project: safe, name: "nod", animation: nod, apply: true }, "safe-apply");
  s.staged = await call("spine_generate_animation", { project: safe, type: "breathe", breathe: { torso: ["torso"], followers: ["head"] }, apply: true, editor: "staging" }, "safe-staged");
  s.status = await call("spine_status", { project: safe, recent: 5 }, "safe-status");
  s.backups = await call("spine_list_backups", { project: safe }, "safe-backups");
  s.restoreDry = await call("spine_restore_backup", { project: safe, backupId: s.apply.backup.id }, "safe-restore-dry");
  const runs = readdirSync(join(repo, ".lab", "conformance")).filter((d) => /^\d+\.\d+\.\d+-/.test(d) && existsSync(join(repo, ".lab", "conformance", d, "results.json"))).sort();
  const latest = runs.filter((d) => d.startsWith("4.3.26-")).pop();
  const results = latest ? JSON.parse(readFileSync(join(repo, ".lab", "conformance", latest, "results.json"), "utf8")) : [];
  s.conformance = { version: "4.3.26", probes: results.length, critical: results.filter((p) => p.critical).length, ok: results.filter((p) => p.ok).length, ids: results.map((p) => p.id) };
  facts.safety = s;
  saveFacts();
}

// ---------- ship: runtime export, Unity and the web (hop-baked: physics as keys, so every renderer draws the same antenna) ----------
if (want("ship")) {
  await deriveAll();
  const x = {};
  x.export = await call("spine_export", { project: bolt, outputDir: join(root, "export-mobile"), preset: "mobile" }, "ship-export");
  x.web = await call("spine_web_check", { project: bolt, animations: ["hop-baked", "wave"] }, "ship-web");
  x.unity = await call("spine_unity_check", { project: bolt, render: true, renderAnimations: ["hop-baked", "wave"] }, "ship-unity");
  x.urp = await call("spine_unity_check", { project: bolt, render: true, renderAnimations: ["hop-baked"], renderPipeline: "urp" }, "ship-urp");
  facts.ship = Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).filter(([, y]) => JSON.stringify(y ?? null).length < 6000))]));
  saveFacts();
}

// ---------- parts: two characters painted together, cut into PNGs, into one rig (no PSD) ----------
if (want("parts")) {
  const ORDER = Object.keys(POS);
  const cut = join(root, "cut");
  mkdirSync(cut, { recursive: true });
  // Two characters on one canvas: Bolt, and a smaller Bolt beside it (the same art scaled).
  const parts = [];
  const place = (who, scale, dx, dy) => {
    for (const n of ORDER) {
      if (n === "shadow") continue;
      const file = `${who}_${n}.png`;
      sh("magick", [join(repo, "demo", "bolt", "images", `${n}.png`), "-resize", `${scale * 100}%`, join(cut, file)]);
      parts.push({ file, x: Math.round(POS[n][0] * scale) + dx, y: Math.round(POS[n][1] * scale) + dy, bone: who });
    }
  };
  place("Bolt", 1, 0, 0);
  place("Pal", 0.72, 400, 150);
  writeFileSync(join(cut, "layout.json"), JSON.stringify({ width: 720, height: 560, parts }, null, 2));
  // The painting: the parts composed in order. A clean cut matches it; a slipped part does not.
  const compose = (out, list) => sh("magick", ["-size", "720x560", "xc:none", ...list.flatMap((p) => [join(cut, p.file), "-geometry", `+${p.x}+${p.y}`, "-composite"]), out]);
  compose(join(cut, "painting.png"), parts);
  writeFileSync(join(cut, "layout.json"), JSON.stringify({ width: 720, height: 560, source: "painting.png", parts }, null, 2));
  // A bad cut: one part slipped 14 px, and specks left on another.
  const bad = join(root, "cut-bad");
  cpSync(cut, bad, { recursive: true });
  const slipped = parts.map((p) => (p.file === "Bolt_head.png" ? { ...p, x: p.x + 14 } : p));
  writeFileSync(join(bad, "layout.json"), JSON.stringify({ width: 720, height: 560, source: "painting.png", parts: slipped }, null, 2));
  sh("magick", [join(bad, "Bolt_torso.png"), "-background", "none", "-gravity", "NorthWest", "-extent", "150x150", "-fill", "#3a3f8f", "-draw", "rectangle 142,4 145,7", join(bad, "Bolt_torso.png")]);
  // The pictures the video shows: the painting, and the same parts as the bad layout places them.
  sh("magick", [join(cut, "painting.png"), "-background", "#F2F3FE", "-flatten", join(OUT, "img", "parts-painting.png")]);
  compose(join(OUT, "img", "parts-slipped.png"), slipped);
  sh("magick", [join(OUT, "img", "parts-slipped.png"), "-background", "#F2F3FE", "-flatten", join(OUT, "img", "parts-slipped.png")]);
  const badOut = await call("spine_import_layers", { parts: bad, output: join(root, "bad.spine") }, "parts-bad");
  const goodOut = await call("spine_import_layers", { parts: cut, output: join(root, "good.spine") }, "parts-good");
  const out = join(root, "pair.spine");
  const sug = await call("spine_auto_rig", { parts: cut, output: out }, "parts-suggest");
  const built = await call("spine_auto_rig", { parts: cut, output: out, bones: sug.suggestions.bones, ik: sug.suggestions.ik, apply: true }, "parts-apply");
  const names = sug.suggestions.bones.map((b) => b.name);
  const of = (who) => names.filter((n) => n.startsWith(`${who}_`));
  const body = (who) => of(who).find((n) => /torso$/.test(n));
  const followers = (who) => of(who).filter((n) => /head$|upper-arm$|upper-arm-back$/.test(n));
  const idle = await call("spine_generate_animation", { project: out, type: "breathe", name: "idle", breathe: { torso: [body("Bolt"), body("Pal")], followers: [...followers("Bolt"), ...followers("Pal")], path: "figure8", period: 3, rise: 4, sway: 2 }, apply: true }, "parts-idle");
  const apart = await call("spine_derive_animation", { project: out, source: "idle", name: "idle-apart", ops: [{ op: "offsetBones", bones: of("Pal"), seconds: 0.8 }], apply: true }, "parts-apart");
  const sway = await call("spine_generate_animation", { project: out, type: "sway", name: "antenna-sway", sway: { bones: of("Bolt").filter((n) => /antenna$/.test(n)), amount: 8, period: 2 }, apply: true }, "parts-sway");
  await renderClip(out, "idle-apart", "parts-idle", 100);
  await renderClip(out, "antenna-sway", "parts-sway", 100);
  const canvas = encodeClips(["parts-idle", "parts-sway"]);
  facts.parts = {
    canvas, partCount: parts.length,
    bad: { source: badOut.parts?.source, artQa: badOut.artQa, problems: badOut.parts?.problems },
    good: { source: goodOut.parts?.source, format: goodOut.parts?.format, parts: goodOut.parts?.parts },
    suggested: { bones: names.length, ik: sug.suggestions.ik?.length ?? 0, notes: sug.suggestions.notes ?? sug.notes },
    built: { bones: built.bones?.length, slots: built.slots?.length, ik: built.ik?.length, check: built.check, verification: built.verification, setupError: built.setupError },
    idle: { keys: idle.summary?.keys, notes: idle.generateNotes, verification: idle.verification, apart: apart.deriveNotes },
    sway: { keys: sway.summary?.keys, notes: sway.generateNotes },
  };
  saveFacts();
}

// ---------- production: a file another tool wrote, keys an animator would redo, a team's rules ----------
if (want("production")) {
  await buildRig();
  const p = {};
  // A foreign file: the rig as JSON with one mesh's vertices listing bones in a conflicting order, and a region drawn at another size than its image.
  const exported = await call("spine_export_json", { project: rig }, "prod-export");
  const doc = JSON.parse(readFileSync(exported.skeletons[0].json, "utf8"));
  doc.skeleton.images = join(rigDir, "images") + "/";
  let flipped = null;
  for (const [slot, atts] of Object.entries(doc.skins[0].attachments)) for (const [name, att] of Object.entries(atts)) {
    if (att.type !== "mesh" || flipped) continue;
    const n = att.uvs.length / 2, v = att.vertices;
    if (v.length <= n * 2) continue;
    // Swap the two bones of the first two-bone vertex only.
    for (let i = 0, k = 0; k < n; k++) {
      const c = v[i];
      if (c === 2) { const a = v.slice(i + 1, i + 5), b = v.slice(i + 5, i + 9); v.splice(i + 1, 8, ...b, ...a); flipped = `${slot}/${name}`; break; }
      i += 1 + c * 4;
    }
  }
  // The shadow as a region drawn at twice its image's size.
  const [sw, sh2] = pngSize(join(rigDir, "images", "shadow.png"));
  doc.skins[0].attachments.shadow = { shadow: { width: sw * 2, height: sh2 * 2 } };
  const stretched = "shadow/shadow";
  const foreign = join(root, "foreign.json");
  writeFileSync(foreign, JSON.stringify(doc));
  p.foreign = { flipped, stretched };
  p.validate = await call("spine_validate", { input: foreign }, "prod-validate");
  p.rigQa = await call("spine_rig_qa", { input: foreign }, "prod-rigqa");
  p.imported = await call("spine_import_layers", { json: foreign, output: join(root, "foreign-in.spine"), apply: true }, "prod-import");

  // Keys a bake left behind: one per frame, between frames, long decimals. The motion is the wave's, sampled.
  const times = Array.from({ length: 61 }, (_, i) => (i ? +(i / 30 + 0.0043).toFixed(6) : 0));
  const curve = (t, amp, ph) => amp * Math.sin((2 * Math.PI * t) / 2 + ph) + 0.000137;
  const baked = { bones: {
    head: { rotate: times.map((t) => ({ time: t, value: curve(t, 9, 0) })) },
    torso: { rotate: times.map((t) => ({ time: t, value: curve(t, 4, 0.6) })) },
    "upper-arm": { rotate: times.map((t) => ({ time: t, value: curve(t, 18, 1.2) })) },
  } };
  await call("spine_add_animation", { project: bolt, name: "baked", animation: baked, apply: true }, "prod-baked");
  p.before = await call("spine_validate", { input: bolt }, "prod-before");
  p.clean = await call("spine_derive_animation", { project: bolt, source: "baked", name: "baked-clean", ops: [{ op: "clean" }], apply: true }, "prod-clean");
  p.after = await call("spine_validate", { input: bolt }, "prod-after");
  await call("spine_motion_visual", { project: bolt, animation: "baked", mode: "graph", size: 900, bones: ["upper-arm"] }, "prod-curves-before");
  await call("spine_motion_visual", { project: bolt, animation: "baked-clean", mode: "graph", size: 900, bones: ["upper-arm"] }, "prod-curves-after");
  await renderClip(bolt, "baked", "prod-baked", 90);
  await renderClip(bolt, "baked-clean", "prod-clean", 90);
  const canvas = encodeClips(["prod-baked", "prod-clean"]);

  // A team's rules: a second server with a profile, and how far each part travels on a phone.
  const profile = join(root, "team.json");
  writeFileSync(profile, JSON.stringify({ name: "team-ui", tools: { spine_export: { format: "binary", premultipliedAlpha: false } }, export: { maxPages: 1, sidesMultipleOf: 4 } }));
  const team = new Client({ name: "make-feature-media-team", version: "0" });
  await team.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, "dist/index.js")], env: { ...process.env, SPINE_MCP_WORKDIR: join(root, "work-team"), SPINE_MCP_PROFILE: profile } }));
  const res = await team.callTool({ name: "spine_export", arguments: { project: bolt, outputDir: join(root, "team-export"), maxSize: 256 } }, undefined, { timeout: 600_000 });
  const teamText = res.content.find((c) => c.type === "text")?.text ?? "";
  if (res.isError) throw new Error(`team export: ${teamText}`);
  p.team = JSON.parse(teamText);
  writeFileSync(join(OUT, "outputs", "prod-team.json"), JSON.stringify(p.team, null, 2));
  await team.close();
  p.travel = await call("spine_measure", { input: bolt, animation: "wave", parts: 0.5 }, "prod-travel");

  const keysOf = (v) => v.summary?.keys;
  facts.production = {
    canvas, foreign: p.foreign,
    validate: (p.validate.issues ?? p.validate.findings ?? []).map((i) => ({ code: i.code, severity: i.severity, message: i.message?.slice(0, 200) })),
    rigQa: (p.rigQa.findings ?? []).filter((f) => /resized/.test(f.code)).map((f) => ({ code: f.code, items: f.items })),
    imported: { mode: p.imported.mode, notes: (p.imported.notes ?? []).filter((n) => /sort|order|scale|region/i.test(n)).map((n) => n.slice(0, 220)), verification: p.imported.verification },
    before: (p.before.issues ?? p.before.findings ?? []).filter((i) => /key-|timeline-end/.test(i.code) && i.message?.startsWith('"baked"')).map((i) => ({ code: i.code, message: i.message?.slice(0, 200) })),
    after: (p.after.issues ?? p.after.findings ?? []).filter((i) => /key-|timeline-end/.test(i.code) && i.message?.startsWith('"baked-clean"')).map((i) => ({ code: i.code, message: i.message?.slice(0, 200) })),
    clean: { keys: keysOf(p.clean), notes: p.clean.deriveNotes, verification: p.clean.verification },
    team: { profile: p.team.profile, atlases: p.team.atlases?.map((a) => ({ pages: a.pages?.length })), format: p.team.format, files: p.team.files?.slice?.(0, 4) },
    travel: (p.travel.parts ?? []).slice(0, 8),
  };
  saveFacts();
}

await client.close();
console.log(`\nfacts: ${factsFile}`);
