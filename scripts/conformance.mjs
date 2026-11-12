#!/usr/bin/env node
// Spine version conformance suite: re-checks the editor CLI behaviors spine-mcp relies on and compares them with a
// saved baseline, so a new Spine release shows exactly what changed and which spine-mcp code to look at.
//
// Usage (outside the Claude Code sandbox, needs Spine Pro; build first):
//   npm run build && node scripts/conformance.mjs                 # pinned version vs its baseline
//   node scripts/conformance.mjs --version 4.3.27                 # a new release vs the newest baseline
//   node scripts/conformance.mjs --save                           # record research/conformance/baseline-<v>.json
//   node scripts/conformance.mjs --against research/conformance/baseline-4.3.26.json
// Exit code: 0 same as baseline, 1 a critical probe failed, 2 behavior changed (read the report).
// Fixtures are built from DFY/bolt.json by the version under test; nothing outside the work folder is touched.
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { loadConfig } from "../dist/config.js";
import { cliFailed, SpineCli } from "../dist/spine/cli.js";
import { compareAnimationAcrossDocs, exportsEqual } from "../dist/spine/compare.js";
import { compareRun, exitCode, normalizeFacts, toBaseline } from "../dist/spine/conformance.js";
import { verifyHeaders } from "../dist/spine/export.js";
import { parseProjectInfo } from "../dist/spine/info.js";
import { renderFrames } from "../dist/spine/render.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = loadConfig();
const version = opt("--version") ?? base.spineVersion;
const config = { ...base, spineVersion: version, workDir: join(repo, ".lab", "conformance", "work") };
const cli = new SpineCli(config);
const baselineDir = join(repo, "research", "conformance");
const work = join(repo, ".lab", "conformance", `${version}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(work, { recursive: true });

// ---------- helpers ----------
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const writeJson = (f, v) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v)); return f; };
let seq = 0;
const tmp = (name) => { const d = join(work, `${String(++seq).padStart(2, "0")}-${name}`); mkdirSync(d, { recursive: true }); return d; };
/** Output lines without timing noise, Spine's own backup counter (G55) or Java stack frames (obfuscated names change per build). */
const lines = (r) => r.lines
  .filter((l) => !/^\s*(at |\.\.\.|<events>)/.test(l) && !/^Backup/i.test(l))
  .map((l) => l.replace(/\b\d+(\.\d+)?\s?(ms|s|seconds)\b/g, "<t>").replace(/-\d+-(?=\d+\.\d+\.\d+)/g, "-<n>-").replace(/\s+\.\.\.$/, ""));

async function exportJson(project) {
  const out = tmp("export");
  const r = await cli.run(["-i", project, "-o", out, "-e", "json"]);
  const files = existsSync(out) ? readdirSync(out).filter((f) => f.endsWith(".json")) : [];
  if (cliFailed(r) || !files.length) throw new Error(`export of ${project} failed: ${[...r.errors, ...r.lines.slice(-3)].join(" | ")}`);
  return readJson(join(out, files[0]));
}
const importProject = (json, out) => cli.run(["-i", json, "-o", out, "-r"]);
const importAnimation = (json, project, skeleton, name, replace = false) =>
  cli.run(["-i", json, "-o", project, "--to", skeleton, "-a", name, ...(replace ? ["--replace"] : []), "-r"]);
/** A copy of the native project to write into. */
const copyProject = (src, name) => { const d = tmp(name); const p = join(d, "bolt.spine"); copyFileSync(src, p); cpSync(join(dirname(src), "images"), join(d, "images"), { recursive: true }); return p; };
/** The exported skeleton plus extra animations, as an import source next to the images. */
const withAnimations = (doc, anims, dir) => writeJson(join(dir, "bolt.json"), { ...doc, skeleton: { ...doc.skeleton, images: "./images/" }, animations: { ...doc.animations, ...anims } });
const problem = (r) => ({ exitCode: r.exitCode, flagged: cliFailed(r) || r.warnings.length > 0, warnings: r.warnings.length, errors: r.errors.length, lines: lines(r) });

// ---------- fixtures: built by the version under test ----------
const fx = tmp("fixtures");
const boltDoc = readJson(join(repo, "DFY", "DFY.json"));
/** `<fx>/<name>/bolt.json` beside its own images: Spine names the skeleton after the JSON file (G66), so it stays "bolt". */
const native = (doc, name) => {
  cpSync(join(repo, "demo", "bolt", "images"), join(fx, name, "images"), { recursive: true });
  return writeJson(join(fx, name, "bolt.json"), { ...doc, skeleton: { ...doc.skeleton, images: "./images/", spine: version } });
};
// A plain 4-vertex mesh on the head image for the mesh probes (Bolt itself has only regions).
const head = PNG.sync.read(readFileSync(join(repo, "demo", "bolt", "images", "head.png")));
const [w, h] = [head.width, head.height];
const meshAtt = { type: "mesh", path: "head", uvs: [0, 1, 1, 1, 1, 0, 0, 0], triangles: [0, 1, 2, 2, 3, 0], vertices: [-w / 2, -h / 2, w / 2, -h / 2, w / 2, h / 2, -w / 2, h / 2], hull: 4, edges: [0, 2, 2, 4, 4, 6, 6, 0], width: w, height: h };
const meshDoc = (edges) => {
  const d = structuredClone(boltDoc);
  const skin = d.skins.find((s) => s.name === "default");
  skin.attachments.head["head-mesh"] = edges ? meshAtt : { ...meshAtt, edges: undefined };
  return d;
};
const boltSpine = join(fx, "bolt", "bolt.spine");
const setup = await importProject(native(boltDoc, "bolt"), boltSpine);
if (cliFailed(setup) || !existsSync(boltSpine)) {
  console.error(`Could not build the Bolt fixture with Spine ${version}: ${[...setup.errors, ...setup.lines.slice(-3)].join(" | ")}`);
  process.exit(1);
}
const meshSpine = join(fx, "mesh", "bolt.spine");
const meshSetup = await importProject(native(meshDoc(true), "mesh"), meshSpine);
const exported = await exportJson(boltSpine);

// ---------- probes ----------
const results = [];
async function probe(id, title, refs, protects, critical, fn) {
  const t0 = Date.now();
  let r;
  try {
    r = await fn();
  } catch (e) {
    r = { ok: false, facts: {}, note: `threw: ${e.message}` };
  }
  const result = normalizeFacts({ id, title, refs, protects, critical, ok: r.ok, facts: r.facts ?? {}, ...(r.note ? { note: r.note } : {}) }, { "<work>": work, "<repo>": repo, "<home>": homedir(), "<v>": version });
  results.push(result);
  console.log(`${r.ok === null ? "skip" : r.ok ? "ok  " : critical ? "FAIL" : "fail"} ${id.padEnd(22)} ${String(Date.now() - t0).padStart(6)} ms  ${title}`);
}

await probe("version-pin", "-u pins the editor build every call uses", ["phase0#10"], "cli.ts SpineCli.spawn (-u), spine_doctor", true, async () => {
  const r = await cli.run(["--version"]);
  const editor = r.raw.match(/Spine (\d+\.\d+\.\d+(?:-\w+)?) (Professional|Essential|Trial)?/)?.[1] ?? null;
  return { ok: editor === version, facts: { editor } };
});

await probe("project-info", "Spine -i output parses (version, skeletons, lists)", ["phase0#12", "G57"], "info.ts parseProjectInfo, write.ts projectEditorVersion", true, async () => {
  const r = await cli.run(["-i", boltSpine]);
  const [p, ...more] = parseProjectInfo(r.lines);
  const sk = p?.skeletons[0];
  return {
    ok: !!p && !more.length && p.spineVersion === version && !!sk?.lists.Animations?.names.includes("idle"),
    facts: { projects: 1 + more.length, spineVersion: p?.spineVersion ?? null, dopesheetFps: p?.dopesheetFps ?? null, skeletons: p?.skeletons.map((s) => s.name), lists: Object.keys(sk?.lists ?? {}).sort(), animations: sk?.lists.Animations?.names ?? [] },
  };
});

await probe("json-export", "-e json: 4.3 format, rotate `value`, defaults omitted", ["phase0#4", "G11", "G82"], "project.ts loadProject, types.ts, spine-core loading", true, async () => {
  const rotateKeys = Object.values(exported.animations ?? {}).flatMap((a) => Object.values(a.bones ?? {}).flatMap((t) => t.rotate ?? []));
  const fields = [...new Set(rotateKeys.flatMap((k) => Object.keys(k)))].sort();
  return {
    ok: exported.skeleton?.spine === version && fields.includes("value") && !fields.includes("angle"),
    facts: {
      spine: exported.skeleton?.spine, skeletonFields: Object.keys(exported.skeleton ?? {}).sort(), topLevel: Object.keys(exported).sort(),
      rotateKeyFields: fields, explicitTimeZero: rotateKeys.some((k) => k.time === 0), bones: exported.bones.length, animations: Object.keys(exported.animations ?? {}).sort(),
    },
  };
});

await probe("settings-class", "export settings `class`: json works (export-json is recorded as a fact)", ["G04"], "export.ts settings files", false, async () => {
  const good = tmp("class-json"), bad = tmp("class-export-json");
  const s1 = writeJson(join(good, "settings.json"), { class: "json", extension: ".json", nonessential: true, prettyPrint: false });
  const s2 = writeJson(join(bad, "settings.json"), { class: "export-json", extension: ".json" });
  const r1 = await cli.run(["-i", boltSpine, "-o", join(good, "out"), "-e", s1]);
  const r2 = await cli.run(["-i", boltSpine, "-o", join(bad, "out"), "-e", s2]);
  const produced = existsSync(join(good, "out")) && readdirSync(join(good, "out")).some((f) => f.endsWith(".json"));
  return { ok: produced && !cliFailed(r1), facts: { jsonClassProduces: produced, exportJsonClass: problem(r2) } };
});

await probe("png-render", "export-png through render.ts: -o is a file prefix, libGDX background", ["G03", "G52", "phase0#8"], "render.ts renderFrames", true, async () => {
  const r = await renderFrames(config, cli, boltSpine, { skeleton: "bolt", animation: "hop", fps: 10, scale: 25, background: "808080ff" });
  const names = r.frames.map((f) => f.split("/").pop().replace(/\d+/g, "#"));
  const img = PNG.sync.read(readFileSync(r.frames[0]));
  return { ok: r.frames.length > 0, facts: { frames: r.frames.length, namePattern: [...new Set(names)], opaqueCorner: img.data[3] === 255 } };
});

await probe("png-hex-background", "a hex string background is rejected (needs libGDX Color)", ["G52"], "render.ts hexToGdxColor", false, async () => {
  const d = tmp("hex-bg");
  const s = writeJson(join(d, "settings.json"), { class: "export-png", exportType: "animation", skeletonType: "single", skeleton: "bolt", animationType: "single", animation: "hop", fps: 10, scale: 25, background: "808080ff" });
  const r = await cli.run(["-i", boltSpine, "-o", join(d, "frame"), "-e", s]);
  return { ok: true, facts: { ...problem(r), frames: readdirSync(d).filter((f) => f.endsWith(".png")).length } };
});

const nod = { bones: { head: { rotate: [{ value: 0 }, { time: 0.3, value: -8 }, { time: 0.6, value: 0 }] } } };
const writeTarget = copyProject(boltSpine, "write");
const before = await exportJson(writeTarget);
const nodSrc = withAnimations(before, { "probe-nod": nod }, dirname(writeTarget));
let afterNod;
await probe("anim-import-lossless", "-a NAME -r adds one animation and changes nothing else", ["phase0#14", "G06"], "write.ts addAnimationLocked + verify (the write path)", true, async () => {
  const r = await importAnimation(nodSrc, writeTarget, "bolt", "probe-nod");
  afterNod = await exportJson(writeTarget);
  const structure = exportsEqual(before, afterNod);
  const others = Object.keys(before.animations).every((n) => JSON.stringify(before.animations[n]) === JSON.stringify(afterNod.animations?.[n]));
  const mine = compareAnimationAcrossDocs(readJson(nodSrc), afterNod, "probe-nod");
  return {
    ok: !cliFailed(r) && !r.warnings.length && !structure.length && others && mine.equal,
    facts: { exitCode: r.exitCode, warnings: r.warnings.length, structureChanged: structure, otherAnimationsIdentical: others, newAnimationMatches: mine.equal, animations: Object.keys(afterNod.animations).sort() },
  };
});

await probe("anim-same-name", "same name without --replace is added as NAME2", ["G07", "phase0#15"], "write.ts refuses existing names before the CLI", false, async () => {
  const r = await importAnimation(nodSrc, writeTarget, "bolt", "probe-nod");
  const after = await exportJson(writeTarget);
  return { ok: true, facts: { ...problem(r), added: Object.keys(after.animations).filter((n) => !afterNod.animations[n]).sort() } };
});

await probe("anim-replace", "--replace swaps the animation in place", ["phase0#16"], "write.ts replace: true", true, async () => {
  const target = copyProject(writeTarget, "replace");
  const prev = await exportJson(target);
  const bigger = { bones: { head: { rotate: [{ value: 0 }, { time: 0.3, value: -14 }, { time: 0.6, value: 0 }] } } };
  const src = withAnimations(prev, { "probe-nod": bigger }, dirname(target));
  const r = await importAnimation(src, target, "bolt", "probe-nod", true);
  const after = await exportJson(target);
  const same = compareAnimationAcrossDocs(readJson(src), after, "probe-nod");
  const names = (d) => Object.keys(d.animations).sort().join(",");
  return { ok: !cliFailed(r) && !r.warnings.length && same.equal && names(prev) === names(after), facts: { exitCode: r.exitCode, warnings: r.warnings.length, replaced: same.equal, sameNames: names(prev) === names(after) } };
});

/**
 * The source skeleton has something the target project lacks (an animation made on another version of the rig):
 * Spine drops those keys with rc 0, so spine-mcp's output parsing must flag the import.
 */
async function flagged(id, title, refs, extend, anim) {
  await probe(id, title, refs, "cli.ts WARNING_PATTERNS / parseCliOutput, write.ts warnings = failure", true, async () => {
    const target = copyProject(boltSpine, id);
    const src = withAnimations(extend(structuredClone(await exportJson(target))), { [id]: anim }, dirname(target));
    const r = await importAnimation(src, target, "bolt", id);
    const p = problem(r);
    const kept = (await exportJson(target)).animations?.[id];
    return { ok: p.flagged, facts: { ...p, imported: !!kept, keptTimelines: kept ? Object.keys(kept).sort() : [] } };
  });
}
const defaultSkin = (d) => d.skins.find((k) => k.name === "default");
await flagged("missing-bone", "a key on a bone the target lacks is flagged (Spine drops it with rc 0)", ["G08", "phase0#17"],
  (d) => { d.bones.push({ name: "probe-bone", parent: "root" }); return d; },
  { bones: { "probe-bone": { rotate: [{ value: 5 }] }, head: { rotate: [{ value: 3 }] } } });
await flagged("missing-attachment", "a key to an attachment the target lacks is flagged", ["G08", "phase0#18"],
  (d) => { defaultSkin(d).attachments.head["probe-attachment"] = { ...defaultSkin(d).attachments.head.head, path: "head" }; return d; },
  { slots: { head: { attachment: [{ time: 0.2, name: "probe-attachment" }] } } });
await flagged("undefined-event", "an event the target does not define is flagged", ["G87"],
  (d) => { d.events = { ...(d.events ?? {}), "probe-event": {} }; return d; },
  { events: [{ time: 0.1, name: "probe-event" }], bones: { head: { rotate: [{ value: 3 }] } } });

await probe("unknown-attachment-silent", "a key to an attachment the source itself lacks is taken silently", ["G08"], "validate.ts must catch it before the CLI", false, async () => {
  const target = copyProject(boltSpine, "unknown-attachment");
  const src = withAnimations(await exportJson(target), { "probe-unknown": { slots: { head: { attachment: [{ time: 0.2, name: "no-such-attachment" }] } } } }, dirname(target));
  const r = await importAnimation(src, target, "bolt", "probe-unknown");
  const kept = (await exportJson(target)).animations?.["probe-unknown"];
  return { ok: true, facts: { ...problem(r), keptKeys: kept?.slots?.head?.attachment ?? null } };
});

await probe("invalid-source", "a corrupt source fails and leaves the project untouched", ["phase0#11", "phase0#19"], "write.ts rollback, cliFailed", true, async () => {
  const target = copyProject(boltSpine, "invalid");
  const shaBefore = sha(target);
  const bad = join(dirname(target), "broken.json");
  writeFileSync(bad, '{ "skeleton": { "spine": "' + version + '" }, "bones": [ { "name": "root" ');
  const r = await importAnimation(bad, target, "bolt", "x");
  const missing = await importAnimation(join(dirname(target), "no-such-file.json"), target, "bolt", "x");
  const untouched = sha(target) === shaBefore;
  return { ok: cliFailed(r) && cliFailed(missing) && untouched, facts: { corrupt: problem(r), missingInput: problem(missing), untouched } };
});

await probe("resave-version", "importing into a project re-saves it in the version under test", ["G09", "G57", "phase0#24"], "write.ts versionGap / allowUpgrade", false, async () => {
  const target = copyProject(join(repo, "DFY", "DFY.spine"), "resave");
  const src = withAnimations(exported, { "probe-nod": nod }, dirname(target));
  // The repo's copy was saved by 4.3.26: on another version this shows a newer or older project being re-saved silently.
  const r = await importAnimation(src, target, "bolt", "probe-nod");
  const after = parseProjectInfo((await cli.run(["-i", target])).lines)[0]?.spineVersion ?? null;
  return { ok: true, facts: { ...problem(r), savedAs: after } };
});

// Key handling: one import, three probes.
const keysTarget = copyProject(boltSpine, "keys");
const keyAnim = {
  bones: {
    head: { rotate: [{ value: 0 }, { time: 0.5, value: 10 }, { time: 0.500005, value: 20 }, { time: 1, value: 0 }, { time: 1.001, value: 5 }, { time: 1.5, value: 0 }] },
    torso: { rotate: [{ value: 0 }, { time: 0.7166667, value: 4 }, { time: 1.5, value: 0 }] },
    antenna: { rotate: [{ value: 5 }, { time: 0.5, value: 5 }, { time: 1, value: 10 }, { time: 1.5, value: 5 }] },
  },
};
const keysSrc = withAnimations(await exportJson(keysTarget), { "probe-keys": keyAnim }, dirname(keysTarget));
const keysRun = await importAnimation(keysSrc, keysTarget, "bolt", "probe-keys");
const keysOut = (await exportJson(keysTarget)).animations?.["probe-keys"];
const times = (t) => (t ?? []).map((k) => k.time ?? 0);
await probe("key-merge", "keys closer than ~1e-5 s merge, 1 ms apart stay", ["G25"], "derive.ts loopFix / offset seam window (1 ms)", false, async () => {
  return { ok: !!keysOut && !cliFailed(keysRun), facts: { headTimes: times(keysOut?.bones?.head?.rotate) } };
});
await probe("float32-times", "key times come back as float32", ["G34", "G56"], "compare.ts sampling between keys, web/unity checks", false, async () => {
  return { ok: !!keysOut, facts: { torsoTimes: times(keysOut?.bones?.torso?.rotate) } };
});
await probe("equal-values-stepped", "an equal-valued linear segment is exported as stepped", ["G23"], "compare.ts behavioral comparison (D13)", false, async () => {
  return { ok: !!keysOut, facts: { antennaCurves: (keysOut?.bones?.antenna?.rotate ?? []).map((k) => k.curve ?? "linear") } };
});

await probe("binary-header", "binary export carries the version where export.ts reads it", ["G82"], "export.ts verifyHeaders", true, async () => {
  const d = tmp("binary");
  const s = writeJson(join(d, "binary.json"), { class: "binary", extension: ".skel", nonessential: false });
  const r = await cli.run(["-i", boltSpine, "-o", join(d, "out"), "-e", s]);
  const files = existsSync(join(d, "out")) ? readdirSync(join(d, "out")) : [];
  const check = verifyHeaders(join(d, "out"), files, version);
  return { ok: !cliFailed(r) && check.length > 0 && check.every((c) => c.ok), facts: { files: files.map((f) => f.replace(/^bolt/, "<name>")).sort(), headers: check.map((c) => c.detail) } };
});

await probe("mesh-import", "a mesh with edges imports cleanly", ["G67"], "autorig.ts / layers.ts mesh output", false, async () => {
  return { ok: !cliFailed(meshSetup) && existsSync(meshSpine), facts: problem(meshSetup) };
});

await probe("mesh-no-edges", "a mesh without edges warns about lost internal edges", ["G67", "G20"], "autorig.ts writes edges, write.ts warnings = failure", false, async () => {
  const r = await importProject(native(meshDoc(false), "noedges"), join(fx, "noedges", "bolt.spine"));
  return { ok: true, facts: problem(r) };
});

await probe("deform-clip", "small deform values and short key times after a round trip", ["G35", "G84"], "compare.ts deform tolerance, deform.ts 6-decimal times", false, async () => {
  if (cliFailed(meshSetup)) return { ok: null, facts: {}, note: "mesh fixture failed" };
  const target = copyProject(meshSpine, "deform");
  const doc = await exportJson(target);
  const verts = [0.001, 0.001, 0.005, 0.005, 0.02, 0.02, 0.5, 0.5];
  const anim = { attachments: { default: { head: { "head-mesh": { deform: [{ vertices: verts }, { time: 0.0333, vertices: verts }, { time: 0.066667, offset: 2, vertices: [0.003, 0.003] }, { time: 0.5 }] } } } } };
  const src = withAnimations(doc, { "probe-deform": anim }, dirname(target));
  const r = await importAnimation(src, target, "bolt", "probe-deform");
  const out = (await exportJson(target)).animations?.["probe-deform"]?.attachments?.default?.head?.["head-mesh"]?.deform ?? [];
  return { ok: !cliFailed(r), facts: { ...problem(r), keys: out.map((k) => ({ time: k.time ?? 0, offset: k.offset ?? 0, vertices: k.vertices ?? [] })) } };
});

await probe("full-roundtrip", "JSON round trip into a new project: what differs", ["G06", "phase0#13"], "rigedit.ts loss report (D53)", false, async () => {
  const d = tmp("roundtrip");
  cpSync(join(repo, "demo", "bolt", "images"), join(d, "images"), { recursive: true });
  const src = writeJson(join(d, "bolt.json"), { ...exported, skeleton: { ...exported.skeleton, images: "./images/" } });
  const r = await importProject(src, join(d, "bolt.spine"));
  const again = await exportJson(join(d, "bolt.spine"));
  const anims = Object.keys(exported.animations).every((n) => JSON.stringify(exported.animations[n]) === JSON.stringify(again.animations?.[n]));
  return { ok: !cliFailed(r), facts: { ...problem(r), sectionsDiffer: exportsEqual(exported, again), animationsIdentical: anims } };
});

await probe("data-version-tag", "data tagged with another version warns on import", ["G76"], "layers.ts version retag", false, async () => {
  const d = tmp("retag");
  cpSync(join(repo, "demo", "bolt", "images"), join(d, "images"), { recursive: true });
  const src = writeJson(join(d, "bolt.json"), { ...boltDoc, skeleton: { ...boltDoc.skeleton, images: "./images/", spine: "4.2.43" } });
  return { ok: true, facts: problem(await importProject(src, join(d, "bolt.spine"))) };
});

// ---------- compare and report ----------
const baselines = existsSync(baselineDir) ? readdirSync(baselineDir).filter((f) => /^baseline-.*\.json$/.test(f)) : [];
const num = (f) => f.replace(/^baseline-|\.json$/g, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
const newest = baselines.sort((a, b) => { const [x, y] = [num(a), num(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i] - x[i]; return 0; })[0];
const againstFile = opt("--against") ?? (baselines.includes(`baseline-${version}.json`) ? join(baselineDir, `baseline-${version}.json`) : newest ? join(baselineDir, newest) : null);
const baseline = againstFile && existsSync(againstFile) ? readJson(againstFile) : null;
const comparisons = compareRun(baseline, results);
const code = exitCode(comparisons);

const report = [
  `# Spine ${version} conformance`, "",
  `Baseline: ${baseline ? `${baseline.version} (${againstFile.replace(repo + "/", "")})` : "none"} · ${results.length} probes · exit ${code}`, "",
  "| Probe | Critical | Status | Protects | Changes |", "|---|---|---|---|---|",
  ...comparisons.map((c) => `| ${c.id} | ${c.critical ? "yes" : ""} | ${c.status} | ${c.protects ?? ""} | ${c.changes.join("<br>").replace(/\|/g, "\\|")} |`),
].join("\n");
writeFileSync(join(work, "report.md"), report + "\n");
writeFileSync(join(work, "results.json"), JSON.stringify(results, null, 2));
console.log("\n" + report);
console.log(`\nReport: ${join(work, "report.md")}`);

if (args.includes("--save")) {
  if (comparisons.some((c) => c.status === "failed" && c.critical)) {
    console.error("Not saved: a critical probe failed.");
    process.exit(1);
  }
  mkdirSync(baselineDir, { recursive: true });
  const file = join(baselineDir, `baseline-${version}.json`);
  writeFileSync(file, JSON.stringify(toBaseline(version, results), null, 2) + "\n");
  console.log(`Saved ${file.replace(repo + "/", "")}`);
}
process.exit(code);
