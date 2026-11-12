// Full audit over every example project: export, inspect, validate, measure, timing, derive invariants,
// a real write + verify + restore on a copy, and a render. Writes .lab/sweep/report.json.
// Usage (outside the sandbox): npm run build && node scripts/sweep.mjs [examplesDir]
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { SpineCli } from "../dist/spine/cli.js";
import { loadProject } from "../dist/spine/project.js";
import { summarizeSkeleton, animationDuration } from "../dist/spine/inspect.js";
import { validateSkeleton } from "../dist/spine/validate.js";
import { loadSkeletonData } from "../dist/spine/runtime.js";
import { sampleAnimation } from "../dist/spine/sample.js";
import { measureMotion } from "../dist/spine/measure.js";
import { timingReport } from "../dist/spine/timing.js";
import { deriveAnimation, deriveAnimationWithNotes } from "../dist/spine/derive.js";
import { compareAnimations } from "../dist/spine/compare.js";
import { addAnimation } from "../dist/spine/write.js";
import { listBackups, restoreFile, sha256File } from "../dist/spine/backup.js";
import { renderFrames } from "../dist/spine/render.js";
import { mixCheck } from "../dist/spine/mix.js";
import { budgetReport } from "../dist/spine/budget.js";
import { rigQa } from "../dist/spine/rigqa.js";
import { skinReport } from "../dist/spine/skins.js";
import { breathe, followThrough, lookAt, suggest } from "../dist/spine/generate.js";
import { imageFrames } from "../dist/spine/imageupdate.js";
import { poseCandidates } from "../dist/spine/poses.js";
import { suggestWalk } from "../dist/spine/walk.js";
import { applyRigEdits } from "../dist/spine/rigedit.js";
import { transferAnimation } from "../dist/spine/transfer.js";
import { diffSkeletons } from "../dist/spine/reimport.js";
import { decodeDrawOrder } from "../dist/spine/mirror.js";
import { BONE_CHANNELS, slotChannels, valueAt, valueAtCh } from "../dist/spine/curves.js";
import { angleDelta } from "../dist/spine/measure.js";

const examples = process.argv[2] ?? join(homedir(), "spine-runtimes/examples");
const root = mkdtempSync(join(tmpdir(), "spine-mcp-sweep-"));
// Working copies (and Unity projects) are large: removed on exit unless KEEP_TMP=1.
process.on("exit", () => { if (!process.env.KEEP_TMP) rmSync(root, { recursive: true, force: true }); });
const config = { ...loadConfig(), workDir: join(root, "work") };
const cli = new SpineCli(config);
const report = { started: new Date().toISOString(), projects: [], problems: [] };
/** JSON with object keys sorted at every level, for order-independent equality. */
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const problem = (where, what) => { report.problems.push({ where, what }); console.log(`  !! ${where}: ${what}`); };

/** Max difference between two animations' bone curves, evaluated exactly (no runtime bezier approximation). */
function curveDelta(a, b, duration) {
  let max = 0, where = "";
  for (const [bone, tls] of Object.entries(a.bones ?? {})) {
    for (const [prop, keys] of Object.entries(tls)) {
      const spec = BONE_CHANNELS[prop];
      const other = b.bones?.[bone]?.[prop];
      if (!spec || !other) continue;
      spec.fields.forEach((f, ch) => {
        // Sample strictly inside (0, D): the seam itself is a discontinuity for non-clean loops.
        for (let i = 0; i < 399; i++) {
          const t = (duration * (i + 0.37)) / 400; // off-grid: avoid sampling exactly on stepped key times
          const d = Math.abs(valueAt(keys, f, ch, spec.neutral, t) - valueAt(other, f, ch, spec.neutral, t));
          if (d > max) { max = d; where = `${bone}.${prop}.${f}@${t.toFixed(3)}`; }
        }
      });
    }
  }
  return { max, where };
}

/** Max abs difference of bone local poses between two animations sampled at 30 fps (no constraints solved). */
function poseDelta(data, a, b) {
  const sa = sampleAnimation(data, a, { fps: 30, warmupLoops: 0 });
  const sb = sampleAnimation(data, b, { fps: 30, warmupLoops: 0 });
  let max = 0;
  const n = Math.min(sa.samples.length, sb.samples.length);
  for (let f = 0; f < n; f++) {
    for (let i = 0; i < sa.bones.length; i++) {
      const x = sa.samples[f][i].local, y = sb.samples[f][i].local;
      max = Math.max(max, Math.abs(angleDelta(x.rotation, y.rotation)), Math.abs(x.x - y.x), Math.abs(x.y - y.y), Math.abs(x.scaleX - y.scaleX) * 100, Math.abs(x.scaleY - y.scaleY) * 100);
    }
  }
  return max;
}

const projects = readdirSync(examples)
  .flatMap((d) => (existsSync(join(examples, d)) && !d.includes(".") ? readdirSync(join(examples, d)).filter((f) => f.endsWith(".spine")).map((f) => join(examples, d, f)) : []));
console.log(`${projects.length} projects`);

for (const src of projects) {
  const name = basename(src, ".spine");
  const work = join(root, "projects", name);
  mkdirSync(work, { recursive: true });
  cpSync(dirname(src), work, { recursive: true });
  const project = join(work, basename(src));
  const entry = { name, skeletons: [] };
  report.projects.push(entry);
  console.log(`\n# ${name}`);
  let loaded;
  try {
    const t0 = Date.now();
    loaded = await loadProject(config, cli, project);
    entry.exportMs = Date.now() - t0;
  } catch (e) {
    problem(name, `export failed: ${e.message}`);
    continue;
  }
  for (const s of loaded.skeletons) {
    const sk = { name: s.name, animations: 0, issues: {} };
    entry.skeletons.push(sk);
    try {
      const sum = summarizeSkeleton(s.name, s.doc);
      sk.counts = sum.counts;
      const issues = validateSkeleton(s.doc);
      for (const i of issues) sk.issues[`${i.severity}:${i.code}`] = (sk.issues[`${i.severity}:${i.code}`] ?? 0) + 1;
      for (const i of issues.filter((x) => x.severity !== "info")) problem(`${name}/${s.name}`, `validator ${i.severity} ${i.code}: ${i.message.slice(0, 160)}`);
    } catch (e) {
      problem(`${name}/${s.name}`, `inspect/validate threw: ${e.stack?.split("\n").slice(0, 3).join(" ")}`);
      continue;
    }
    let data;
    try {
      data = loadSkeletonData(s.doc, s.name);
    } catch (e) {
      problem(`${name}/${s.name}`, `runtime load: ${e.message}`);
      continue;
    }
    // Transition and budget reports must run on every rig (crash = finding); results go to the report, not problems.
    try {
      const mix = mixCheck(data, s.doc.animations ?? {}, { limit: 40 });
      const budget = budgetReport(data, s.doc.animations ?? {}, { pagesKnown: false });
      sk.mix = { tested: mix.tested, failing: mix.failing, lateFirstKeys: mix.lateFirstKeys.length };
      const self = diffSkeletons(s.doc, s.doc);
      if (self.broken.length || self.changed.length || self.animations.length) problem(`${name}/${s.name}`, `re-import diff against itself is not empty: ${[...self.broken, ...self.changed].slice(0, 2).map((x) => `${x.where} ${x.detail}`).join("; ")}`);
      sk.budget = { vertexTransforms: budget.worst.vertexTransforms, clippedTriangles: budget.worst.clippedTriangles, batches: budget.worst.drawCalls };
    } catch (e) {
      problem(`${name}/${s.name}`, `mix/budget threw: ${e.stack?.split("\n").slice(0, 2).join(" ")}`);
    }
    // Rig QA warnings on official rigs are false positives (findings); skins must report on every rig; a generated breath must validate.
    try {
      const qa = rigQa(s.doc, { baseDir: dirname(project), otherSkeletons: loaded.skeletons.filter((k) => k !== s).map((k) => k.doc) });
      sk.rigQa = Object.fromEntries(qa.findings.map((f) => [f.code, f.items?.length ?? 1]));
      for (const f of qa.findings.filter((x) => x.severity === "warning")) problem(`${name}/${s.name}`, `rig QA warning ${f.code}: ${(f.items ?? []).slice(0, 3).join(" | ")}`);
      const skins = skinReport(s.doc, data, { pagesKnown: false, animations: false });
      sk.skins = skins.rows.length;
      const cand = suggest(s.doc);
      if (cand.torso.length && Object.keys(s.doc.animations ?? {}).length) {
        const br = breathe(s.doc, { torso: cand.torso.slice(0, 1), followers: cand.followers.slice(0, 2) });
        const bad = validateSkeleton({ ...s.doc, animations: { ...s.doc.animations, "mcp-breathe": br.animation } }, { loopAnimations: ["mcp-breathe"], runtimeAnimations: ["mcp-breathe"] })
          .filter((i) => i.severity !== "info" && i.where?.startsWith("animations/mcp-breathe"));
        for (const i of bad) problem(`${name}/${s.name}`, `generated breathe: ${i.code} ${i.message.slice(0, 140)}`);
      }
    } catch (e) {
      problem(`${name}/${s.name}`, `rig QA/skins/generate threw: ${e.stack?.split("\n").slice(0, 2).join(" ")}`);
    }
    // 0.16-0.20 code on every rig: where the setup pose draws each image (update_images), the new suggestions, and
    // generated look-at / follow-through that must validate.
    try {
      const frames = [...imageFrames(s.doc).values()];
      const why = {};
      for (const f of frames.filter((x) => !x.ok)) why[f.why] = (why[f.why] ?? 0) + 1;
      sk.imageFrames = { ok: frames.filter((x) => x.ok).length, skipped: why };
      const cand = suggest(s.doc);
      const first = Object.keys(s.doc.animations ?? {}).find((n) => animationDuration(s.doc.animations[n]) > 0);
      const check = (label, anim) => {
        const bad = validateSkeleton({ ...s.doc, animations: { ...s.doc.animations, [label]: anim } }, { runtimeAnimations: [label] })
          .filter((i) => i.severity === "error" && i.where?.startsWith(`animations/${label}`));
        for (const i of bad) problem(`${name}/${s.name}`, `generated ${label}: ${i.code} ${i.message.slice(0, 140)}`);
      };
      if (cand.look.bones.length) check("mcp-look", lookAt(s.doc, { bones: cand.look.bones, looks: [{ time: 0.5, angle: 15 }], duration: 2 }).animation);
      if (cand.dangling.length && first) {
        try { check("mcp-follow", followThrough(s.doc, s.doc.animations[first], { bones: cand.dangling }).animation); }
        catch (e) { if (!/length|physics/.test(e.message)) throw e; }
      }
      // 0.23-0.29: spline pass on every animation, key poses, leg suggestions, a rig edit applied in memory; all must validate.
      for (const [n, a] of Object.entries(s.doc.animations ?? {})) {
        const sp = deriveAnimation(a, [{ op: "spline" }], { skeleton: s.doc });
        const bad = validateSkeleton({ ...s.doc, animations: { ...s.doc.animations, [n]: sp } }, { runtimeAnimations: [n] }).filter((i) => i.severity === "error" && i.where?.startsWith(`animations/${n}`)); // other animations stay (sliders read them)
        for (const i of bad.slice(0, 2)) problem(`${name}/${s.name}`, `spline ${n}: ${i.code} ${i.message.slice(0, 120)}`);
      }
      const poses = poseCandidates(s.doc), legs = suggestWalk(s.doc);
      const edited = applyRigEdits(s.doc, [{ op: "addEvent", name: "mcp-sweep" }, { op: "addBone", name: "mcp-sweep-bone", parent: s.doc.bones[0].name }]).doc;
      for (const i of validateSkeleton(edited).filter((x) => x.severity === "error").slice(0, 2)) problem(`${name}/${s.name}`, `rig edit: ${i.code} ${i.message.slice(0, 120)}`);
      sk.generators = { look: cand.look.bones.length > 0, follow: cand.dangling.length, mouths: cand.mouths.length, keyPoses: Object.values(poses).reduce((a, b) => a + b.length, 0), legs: legs.legs.length };
    } catch (e) {
      problem(`${name}/${s.name}`, `imageFrames/lookAt/followThrough threw: ${e.stack?.split("\n").slice(0, 2).join(" ")}`);
    }
    for (const [animName, anim] of Object.entries(s.doc.animations ?? {})) {
      sk.animations++;
      const where = `${name}/${s.name}/${animName}`;
      try {
        const m = measureMotion(sampleAnimation(data, animName, { fps: 30 }));
        if (m.bones.some((b) => !Number.isFinite(b.maxSpeed))) problem(where, "non-finite speed");
        timingReport(animName, anim);
        const D = animationDuration(anim);
        // Derive invariants on a scratch document.
        const doc = structuredClone(s.doc);
        const variants = {
          __id: deriveAnimation(anim, [{ op: "retime", factor: 1 }, { op: "scaleValues", factor: 1 }]),
          __rt: deriveAnimation(deriveAnimation(anim, [{ op: "retime", factor: 2 }]), [{ op: "retime", factor: 0.5 }]),
          __loop: deriveAnimation(anim, [{ op: "loopFix" }].filter(() => D > 0)),
          __ease: deriveAnimation(anim, [{ op: "ease", easing: "easeInOut" }]),
          __big: deriveAnimation(anim, [{ op: "scaleValues", factor: 1.5 }]),
        };
        const bones = Object.keys(anim.bones ?? {});
        if (D > 0 && bones.length) variants.__off = deriveAnimation(deriveAnimation(anim, [{ op: "offsetBones", bones, seconds: D * 0.37 }]), [{ op: "offsetBones", bones, seconds: -D * 0.37 }]);
        // Slot round trip (colors) and mirror/swap validity.
        const slotNames = [...new Set([...Object.keys(anim.slots ?? {}), ...Object.values(anim.attachments ?? {}).flatMap((bySlot) => Object.keys(bySlot))])];
        if (D > 0 && slotNames.length) {
          variants.__soff = deriveAnimation(deriveAnimation(anim, [{ op: "offsetSlots", slots: slotNames, seconds: D * 0.29 }], { skeleton: s.doc }), [{ op: "offsetSlots", slots: slotNames, seconds: -D * 0.29 }], { skeleton: s.doc });
          let worst = 0;
          for (const [slot, tls] of Object.entries(anim.slots ?? {})) {
            for (const [prop, keys] of Object.entries(tls)) {
              const ch = slotChannels(prop);
              const other = variants.__soff.slots?.[slot]?.[prop];
              if (!ch || !other) continue;
              for (let i = 0; i < 199; i++) {
                const t = (D * (i + 0.37)) / 200;
                for (let c = 0; c < ch.count; c++) worst = Math.max(worst, Math.abs(valueAtCh(keys, ch, c, t) - valueAtCh(other, ch, c, t)));
              }
            }
          }
          if (worst > 0.02) problem(where, `offsetSlots +x -> -x not identity on colors (max ${worst.toFixed(4)})`);
        }
        variants.__mirror = deriveAnimation(anim, [{ op: "mirror" }], { skeleton: s.doc });
        variants.__swap = deriveAnimation(anim, [{ op: "swapBones" }], { skeleton: s.doc });
        if (D > 0 && (s.doc.constraints ?? []).some((c) => c.type === "physics")) {
          const baked = deriveAnimationWithNotes(anim, [{ op: "bakePhysics" }], { skeleton: s.doc });
          variants.__bake = baked.animation;
          const inexact = baked.notes.find((n) => n.startsWith("not exact"));
          if (inexact) problem(where, `bakePhysics ${inexact.slice(0, 160)}`);
        }
        // Transferring an animation onto its own skeleton must not change it (draw order folders are per skeleton
        // and reported as dropped).
        {
          const { animation: same, report: tr } = transferAnimation(anim, s.doc, s.doc);
          const { drawOrderFolder: _f, ...expected } = anim;
          // Draw order keys can have several equally minimal encodings: compare the decoded orders.
          const base = (s.doc.slots ?? []).map((x) => x.name);
          const decoded = (a) => (a.drawOrder ? { ...a, drawOrder: a.drawOrder.map((k) => ({ time: k.time, order: k.offsets ? decodeDrawOrder(base, k.offsets) : null })) } : a);
          if (tr.unmatched.length || canonical(decoded(same)) !== canonical(decoded(expected))) {
            problem(where, `transfer onto itself changed it: ${tr.unmatched.length} unmatched, keys ${tr.keysIn} -> ${tr.keysOut}${tr.dropped.length ? `, ${tr.dropped.slice(0, 2).join("; ")}` : ""}`);
          }
        }
        if (D > 0) {
          // repeat x2 must equal looping, bone curves evaluated exactly (outside the 1 ms seam holds).
          const rep = deriveAnimation(anim, [{ op: "repeat", times: 2 }], { skeleton: s.doc });
          variants.__repeat = rep;
          let worstRep = 0;
          for (const [bone, tls] of Object.entries(anim.bones ?? {})) for (const [prop, keys] of Object.entries(tls)) {
            const spec = BONE_CHANNELS[prop];
            if (!spec) continue;
            spec.fields.forEach((f, ch) => {
              for (let k = 0; k < 60; k++) {
                const t = (2 * D * (k + 0.37)) / 60, tm = t % D;
                if (D - tm < 0.0015 || tm < (keys[0].time ?? 0)) continue;
                worstRep = Math.max(worstRep, Math.abs(valueAt(keys, f, ch, spec.neutral, tm) - valueAt(rep.bones[bone][prop], f, ch, spec.neutral, t)));
              }
            });
          }
          if (worstRep > 1e-4) problem(where, `repeat x2 differs from looping by ${worstRep.toFixed(5)}`);
        }
        Object.assign((doc.animations ??= {}), variants);
        const vIssues = validateSkeleton(doc, { runtime: false }).filter((i) => i.severity === "error" && i.where?.includes("/__"));
        for (const i of vIssues.slice(0, 3)) problem(where, `derived variant invalid: ${i.code} ${i.message.slice(0, 140)}`);
        const vdata = loadSkeletonData(doc, s.name);
        const ident = compareAnimations(vdata.findAnimation(animName), vdata.findAnimation("__id"), { a: vdata, b: vdata });
        if (!ident.equal) problem(where, `identity derive differs: ${ident.differences.slice(0, 2).join("; ")}`);
        const rt = curveDelta(anim, variants.__rt, D);
        if (rt.max > 1e-6) problem(where, `retime 2 -> 0.5 not identity (max ${rt.max.toFixed(6)} at ${rt.where})`);
        const rtPose = poseDelta(vdata, animName, "__rt");
        if (rtPose > 1e-3) problem(where, `retime 2 -> 0.5 runtime pose delta ${rtPose.toFixed(4)}`);
        if (variants.__off) {
          const off = curveDelta(anim, variants.__off, D);
          // Allowed: seam-jump hold window (0.1 ms) times the curve's speed.
          if (off.max > 0.5) problem(where, `offset +x -> -x not identity (max ${off.max.toFixed(4)} at ${off.where})`);
        }
      } catch (e) {
        problem(where, `analysis threw: ${e.stack?.split("\n").slice(0, 2).join(" ")}`);
      }
    }
  }
  // One real write + verify + restore per project (first skeleton, first animation).
  const first = loaded.skeletons[0];
  const firstAnim = Object.keys(first.doc.animations ?? {})[0];
  if (firstAnim) {
    try {
      const before = sha256File(project);
      const t0 = Date.now();
      const r = await addAnimation(config, cli, {
        project, skeleton: first.name, name: `${firstAnim}-sweep`,
        animation: deriveAnimation(first.doc.animations[firstAnim], [
          { op: "ease", easing: "easeInOutSine" }, { op: "scaleValues", factor: 1.2 },
          ...(animationDuration(first.doc.animations[firstAnim]) > 0 ? [{ op: "offsetSlots", slots: [...new Set([...Object.keys(first.doc.animations[firstAnim].slots ?? {}), ...Object.values(first.doc.animations[firstAnim].attachments ?? {}).flatMap((b) => Object.keys(b))])], seconds: 0.05 }] : []),
        ], { skeleton: first.doc }),
        apply: true,
        allowUpgrade: true, // copies; several official examples were last saved with an older Spine
      });
      entry.writeMs = Date.now() - t0;
      if (r.mode !== "applied" || r.verification?.differences.length) problem(name, `write not verified: ${JSON.stringify(r.verification)}`);
      restoreFile(listBackups(config, project).at(-1), project);
      if (sha256File(project) !== before) problem(name, "restore did not return the original bytes");
    } catch (e) {
      problem(name, `write/restore: ${e.message.slice(0, 300)}`);
    }
    try {
      const r = await renderFrames(config, cli, project, { skeleton: first.name, animation: firstAnim, fps: 10, scale: 20 });
      entry.renderFrames = r.frames.length;
    } catch (e) {
      problem(name, `render: ${e.message.slice(0, 200)}`);
    }
  }
}
report.finished = new Date().toISOString();
mkdirSync(join(process.cwd(), ".lab", "sweep"), { recursive: true });
writeFileSync(join(process.cwd(), ".lab", "sweep", "report.json"), JSON.stringify(report, null, 1));
console.log(`\n${report.projects.length} projects, ${report.projects.reduce((n, p) => n + p.skeletons.reduce((m, s) => m + s.animations, 0), 0)} animations, ${report.problems.length} problems`);
