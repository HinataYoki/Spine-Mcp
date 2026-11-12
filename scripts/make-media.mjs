// Generates the README media from the Bolt demo through the real MCP server (stdio):
// contact sheets, GIFs, a derived variant, an A/B comparison and captured tool outputs.
// Usage (outside the sandbox, needs Spine Pro + ffmpeg): npm run build && node scripts/make-media.mjs
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = process.cwd();
const media = join(repo, "docs", "media");
mkdirSync(media, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "spine-mcp-media-"));
cpSync(join(repo, "DFY"), join(root, "bolt"), { recursive: true });
const project = join(root, "bolt", "bolt.spine");
const outputs = {};

const client = new Client({ name: "make-media", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: [join(repo, "dist/index.js")], env: { ...process.env, SPINE_MCP_WORKDIR: join(root, "work") } }));
async function call(name, args, save) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  if (r.isError) throw new Error(`${name}: ${text}`);
  r.content.filter((c) => c.type === "image").forEach((img, i) => save && writeFileSync(join(media, `${save}${i ? `-${i + 1}` : ""}.png`), Buffer.from(img.data, "base64")));
  const value = JSON.parse(text);
  outputs[`${name}${save ? `:${save}` : ""}`] = { args: { ...args, project: args.project && "…/bolt.spine", input: args.input && "…/bolt.spine" }, result: value };
  console.log(`${name} ok`);
  return value;
}

/** Spine-rendered frames -> GIF on a light background (ffmpeg palette for clean colours). */
function gif(dir, out, fps = 30, width = 300) {
  const frames = readdirSync(dir).filter((f) => /^frame.*\.png$/.test(f)).sort();
  if (!frames.length) throw new Error(`no frames in ${dir}`);
  const flat = join(dir, "flat");
  mkdirSync(flat, { recursive: true });
  frames.forEach((f, i) => execFileSync("magick", [join(dir, f), "-background", "#F4F5FF", "-flatten", "-resize", `${width}x`, join(flat, `f${String(i).padStart(4, "0")}.png`)]));
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(flat, "f%04d.png"),
    "-filter_complex", "fps=20,split[a][b];[b]palettegen=max_colors=256:stats_mode=full[p];[a][p]paletteuse=dither=bayer:bayer_scale=5", "-loop", "0", join(media, out)]);
  console.log("gif", out, frames.length, "frames");
}

/** Two frame folders -> one side-by-side GIF (same frame count expected). */
function gifPair(dirA, dirB, out, fps = 30, width = 320, height = Math.round(width * 0.9)) {
  const flat = (dir) => {
    const frames = readdirSync(dir).filter((f) => /^frame.*\.png$/.test(f)).sort();
    const target = join(dir, "flat");
    mkdirSync(target, { recursive: true });
    frames.forEach((f, i) => execFileSync("magick", [join(dir, f), "-background", "#F4F5FF", "-flatten", "-resize", `${width}x${height}`, "-gravity", "center", "-extent", `${width}x${height}`, join(target, `f${String(i).padStart(4, "0")}.png`)]));
    return target;
  };
  const a = flat(dirA), b = flat(dirB);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(a, "f%04d.png"), "-framerate", String(fps), "-i", join(b, "f%04d.png"),
    "-filter_complex", "[0][1]hstack=inputs=2,fps=20,split[x][y];[y]palettegen=max_colors=256:stats_mode=full[p];[x][p]paletteuse=dither=bayer:bayer_scale=5", "-loop", "0", join(media, out)]);
  console.log("gif pair", out);
}

await call("spine_project_info", { paths: [project] });
const summary = await call("spine_inspect", { input: project });
await call("spine_validate", { input: project, loopAnimations: ["idle", "wave"] });
await call("spine_timing", { input: project, animation: "hop" });
await call("spine_measure", { input: project, animation: "hop", bones: ["hip", "upper-arm", "antenna-tip"] });

for (const anim of ["idle", "wave", "hop"]) {
  const r = await call("spine_render_frames", { project, animation: anim, scale: 60, maxFrames: 8, cell: 200, fps: 30 }, `bolt-${anim}-sheet`);
  gif(r.dir, `bolt-${anim}.gif`);
}

// A derived variant: bigger, slower hop with follow-through on the arms, eased, written safely.
const ops = [
  { op: "scaleValues", factor: 1.35, kinds: ["rotate"] },
  { op: "retime", factor: 1.2 },
  { op: "offsetBones", bones: ["upper-arm", "upper-arm-back"], seconds: 0.06, wrap: false },
];
await call("spine_derive_animation", { project, source: "hop", name: "hop-big", ops }, "derive-dry");
await call("spine_derive_animation", { project, source: "hop", name: "hop-big", ops, apply: true }, "derive-apply");
await call("spine_compare_animations", { input: project, a: "hop", b: "hop-big", bones: ["hip", "upper-arm", "thigh", "shin"], render: true }, "bolt-compare");
const big = await call("spine_render_frames", { project, animation: "hop-big", scale: 60, maxFrames: 8, cell: 200 }, "bolt-hop-big-sheet");
gif(big.dir, "bolt-hop-big.gif");

// Follow-through on a loop: antenna-free arms lag the body on the idle.
await call("spine_derive_animation", { project, source: "wave", name: "wave-overlap", ops: [{ op: "offsetBones", bones: ["lower-arm"], seconds: 0.08 }, { op: "loopFix" }], apply: true }, "derive-overlap");
// Mirror: the other arm waves (Bolt's paired bones are named x / x-back).
const pairs = [["upper-arm", "upper-arm-back"], ["lower-arm", "lower-arm-back"], ["thigh", "thigh-back"], ["shin", "shin-back"]];
await call("spine_derive_animation", { project, source: "wave", name: "wave-mirrored", ops: [{ op: "mirror", pairs }], apply: true }, "derive-mirror");
const wa = await call("spine_render_frames", { project, animation: "wave", scale: 60, maxFrames: 4 });
const wb = await call("spine_render_frames", { project, animation: "wave-mirrored", scale: 60, maxFrames: 4 });
gifPair(wa.dir, wb.dir, "bolt-wave-vs-mirror.gif", 30, 260, 400);
await call("spine_export", { project, outputDir: join(root, "runtime"), format: "both", scales: [1, 0.5] });
await call("spine_list_backups", { project });

// Official example (non-commercial art, redistributed with its license in docs/media/examples): raptor tail follow-through.
const raptorSrc = join(repo, ".lab", "fixtures", "raptor");
if (process.env.SKIP_EXAMPLES !== "1") {
  cpSync(raptorSrc, join(root, "raptor"), { recursive: true });
  const raptor = join(root, "raptor", "raptor-pro.spine");
  const bones = (await call("spine_inspect", { input: raptor, view: "bones" })).map((b) => b.name).filter((n) => /^tail\d+$/.test(n));
  bones.sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  const tailOps = bones.map((bone, i) => ({ op: "offsetBones", bones: [bone], seconds: +((i + 1) * 0.025).toFixed(3) }));
  await call("spine_derive_animation", { project: raptor, source: "walk", name: "walk-follow", ops: tailOps, apply: true }, "raptor-derive");
  const cmp = await call("spine_compare_animations", { input: raptor, a: "walk", b: "walk-follow", bones });
  const ra = await call("spine_render_frames", { project: raptor, animation: "walk", scale: 35, maxFrames: 6 });
  const rb = await call("spine_render_frames", { project: raptor, animation: "walk-follow", scale: 35, maxFrames: 6 });
  gifPair(ra.dir, rb.dir, "examples/raptor-walk-vs-follow.gif");
  console.log("raptor activity ratio", cmp.overallActivityRatio);
}

// Mask machine-specific paths before committing the captured outputs.
const masked = JSON.stringify(outputs, null, 1).split(root).join("<workdir>").replace(/\/Users\/[^/"]+\//g, "~/");
writeFileSync(join(media, "tool-outputs.json"), masked);
console.log("bones:", summary.counts.bones, "animations:", summary.counts.animations);
await client.close();
