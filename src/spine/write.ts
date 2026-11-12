import { mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { createBackup, restoreFile, type BackupEntry } from "./backup.js";
import { cliFailed, type SpineCli } from "./cli.js";
import { EDITOR_OPEN_NOTE, EDITOR_UNKNOWN_NOTE, editorStatus, useStaging, type EditorMode, type EditorStatus } from "./editor.js";
import { resolveStagingPath, stagedWrite, stagingLockKey } from "./staging.js";
import { parseProjectInfo } from "./info.js";
import { compareAnimationAcrossDocs, compareAnimations, exportsEqual } from "./compare.js";
import { summarizeAnimation, type AnimationSummary } from "./inspect.js";
import { assertInputPath, exportCacheDir, loadProject, pickSkeleton, pruneDir, UserError } from "./project.js";
import { loadSkeletonData } from "./runtime.js";
import { recordStep } from "./trajectory.js";
import type { AnimationJson, SkeletonJson } from "./types.js";
import { validateSkeleton, type Issue } from "./validate.js";
import { fileKey } from "../platform.js";

export interface AddAnimationOptions {
  project: string;
  skeleton?: string;
  name: string;
  animation: AnimationJson;
  /** false (default) = dry-run: validate and report, touch nothing. */
  apply?: boolean;
  /** Replace an existing animation with the same name (otherwise refused). */
  replace?: boolean;
  /** Animations that must loop cleanly, passed to the validator. */
  loopAnimations?: string[];
  /** auto (default): write a staging copy while a Spine editor window is open; staging: always; inPlace: never. */
  editor?: EditorMode;
  /** Staging copy path (default `<name>-mcp-staging.spine` next to the project). */
  stagingPath?: string;
  /** Allow writing a project saved by an older Spine major.minor: the write saves it in the pinned version's format. */
  allowUpgrade?: boolean;
  /** Which tool asked for the write and a short summary, for the project's trajectory log. */
  trace?: { tool: string; detail?: string };
}

export interface Verification {
  animationMatches: boolean;
  otherAnimationsUnchanged: boolean;
  structureUnchanged: boolean;
  differences: string[];
}

export interface AddAnimationResult {
  mode: "dry-run" | "applied";
  project: string;
  skeleton: string;
  name: string;
  replaced: boolean;
  summary: AnimationSummary;
  /** Issues in the new animation (blocking errors stop `apply`). */
  issues: Issue[];
  /** Errors that already existed in the project (reported, not blocking). */
  preexistingErrors: number;
  backup?: BackupEntry;
  verification?: Verification;
  cli?: { seconds: number; lines: string[] };
  /** Set when the change went to a staging copy (editor open) instead of the project. */
  staged?: {
    project: string; stagedProject: string; reused: boolean;
    /** Everything spine-mcp wrote into the staging copy that the project does not have yet, per skeleton: tick all of it in Import Project. */
    pending: { skeleton: string; animations: string[] }[];
    /** After an editor save the copy is rebuilt: pending animations carried over, any that could not be, ones now imported, ones the project changed since. */
    carried?: string[]; dropped?: string[]; imported?: string[]; changed?: string[];
    importSteps: string[];
  };
  editor?: EditorStatus;
  notes: string[];
}

const EDITOR_NOTE = "If this project is open in the Spine editor, reopen it before editing: saving the already-open copy would overwrite this change.";

/**
 * Adds (or, with `replace`, replaces) one animation in a .spine project through the CLI's animation import, which keeps
 * all other project data intact (research/phase0 #14). Full skeleton re-import is never used (GOTCHAS G06).
 */
export async function addAnimation(config: Config, cli: SpineCli, o: AddAnimationOptions): Promise<AddAnimationResult> {
  assertInputPath(o.project, [".spine"]);
  const base = { tool: o.trace?.tool ?? "spine_add_animation", detail: o.trace?.detail, animation: o.name.trim() };
  try {
    const r = await addAnimationTraced(config, cli, o);
    if (r.mode === "applied") {
      recordStep(config, o.project, {
        ...base, outcome: r.staged ? "staged" : "applied", skeleton: r.skeleton, replaced: r.replaced || undefined,
        duration: r.summary.duration, keys: r.summary.keys, backupId: r.backup?.id, staged: r.staged?.stagedProject,
      });
    }
    return r;
  } catch (e) {
    if (e instanceof RolledBack) recordStep(config, o.project, { ...base, outcome: "rolledBack", error: e.message.slice(0, 300) });
    throw e;
  }
}

async function addAnimationTraced(config: Config, cli: SpineCli, o: AddAnimationOptions): Promise<AddAnimationResult> {
  const status = editorStatus(config.spineBin, o.project);
  if (o.apply && useStaging(o.editor, status)) {
    // The open editor would not see an in-place write and a later save there would replace it: write a verified copy instead.
    const staging = resolveStagingPath(config, o.project, o.stagingPath);
    const r = await withProjectLock(stagingLockKey(staging), () => stagedWrite(config, cli, o, staging));
    r.editor = status;
    r.notes = r.notes.filter((n) => n !== EDITOR_NOTE && !n.startsWith("Undo with"));
    r.notes.unshift(status.running
      ? `A Spine editor window is open (this project: ${status.projectOpen}), so the original was not touched: the change was written and verified in the staging copy. Bring it in with Import Project (steps in staged.importSteps).`
      : status.unknown && o.editor !== "staging" ? `${EDITOR_UNKNOWN_NOTE} The original was not touched; bring the change in with Import Project (steps in staged.importSteps).`
      : "Written and verified in the staging copy (editor: staging); the original was not touched.");
    if (r.staged?.dropped?.length) r.notes.unshift(`The project was saved since the staging copy was made; ${r.staged.dropped.length} pending animation(s) could not be carried into the rebuilt copy: ${r.staged.dropped.join(", ")}. The old copy is in spine_list_backups for ${staging}.`);
    if (r.staged?.changed?.length) r.notes.push(`No longer offered because the project changed or removed them since spine-mcp wrote them: ${r.staged.changed.join(", ")}.`);
    return r;
  }
  // A write saves the project in the pinned editor's format: an older project could no longer be opened by its own editor.
  const upgrade = o.apply && !o.allowUpgrade ? await versionGap(config, cli, o.project) : null;
  if (upgrade?.minor) {
    throw new UserError(`${o.project} was saved with Spine ${upgrade.from}; writing it saves it as Spine ${upgrade.to}, which Spine ${upgrade.from.split(".").slice(0, 2).join(".")} cannot open. Write a copy (editor: "staging"), or pass allowUpgrade: true if the project is moving to ${upgrade.to}.`);
  }
  // One write per project at a time: the CLI queue serializes single calls, not read -> backup -> import -> verify.
  const r = await withProjectLock(fileKey(o.project), () => addAnimationLocked(config, cli, o));
  if (upgrade && r.mode === "applied") r.notes.unshift(`The project was saved with Spine ${upgrade.from} and is now in Spine ${upgrade.to} format.`);
  if (status.running) {
    r.editor = status;
    if (r.mode === "applied") r.notes.unshift(EDITOR_OPEN_NOTE);
    else if (o.editor !== "inPlace") r.notes.push("A Spine editor window is open: apply: true will write a verified staging copy for Import Project instead of the original (editor: inPlace overrides).");
  }
  return r;
}

const versions = new Map<string, string | null>();

/** The editor version the project was last saved with (Spine -i, cached by file state). */
export async function projectEditorVersion(cli: SpineCli, project: string): Promise<string | null> {
  const st = statSync(project);
  const key = `${fileKey(project)}|${st.mtimeMs}|${st.size}`;
  if (!versions.has(key)) versions.set(key, parseProjectInfo((await cli.run(["-i", project])).lines)[0]?.spineVersion ?? null);
  return versions.get(key)!;
}

/** Older project than the pinned editor: `minor` when major.minor differs (the file format changes). */
async function versionGap(config: Config, cli: SpineCli, project: string): Promise<{ from: string; to: string; minor: boolean } | null> {
  if (!config.spineVersion) return null;
  const from = await projectEditorVersion(cli, project);
  if (!from) return null;
  const num = (v: string) => v.split(/[.-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
  const [a, b] = [num(from), num(config.spineVersion)];
  const older = a[0]! < b[0]! || (a[0] === b[0] && (a[1]! < b[1]! || (a[1] === b[1] && a[2]! < b[2]!)));
  return older ? { from, to: config.spineVersion, minor: a[0] !== b[0] || a[1] !== b[1] } : null;
}

const locks = new Map<string, Promise<unknown>>();
async function withProjectLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}

class RolledBack extends UserError {}
/** The restore itself failed: reported once, never retried by the outer catch. */
class RollbackFailed extends UserError {}

/** The guarded write itself; callers hold the project lock. */
export async function addAnimationLocked(config: Config, cli: SpineCli, o: AddAnimationOptions): Promise<AddAnimationResult> {
  const name = o.name.trim();
  if (!name) throw new UserError("Animation name must not be empty");
  if (!o.animation || typeof o.animation !== "object" || Array.isArray(o.animation)) throw new UserError("`animation` must be a Spine 4.3 animation object");

  const cacheKey = exportCacheDir(config, o.project);
  const before = await loadProject(config, cli, o.project);
  const target = pickSkeleton(before, o.skeleton);
  const exists = Boolean(target.doc.animations?.[name]);
  if (exists && !o.replace) {
    throw new UserError(`Animation "${name}" already exists in "${target.name}". Pick a new name (recommended) or pass replace: true.`);
  }

  const candidate: SkeletonJson = structuredClone(target.doc);
  candidate.animations = { ...(candidate.animations ?? {}), [name]: zeroTinyValues(o.animation) };

  const baseline = new Set(validateSkeleton(target.doc, { runtime: false }).filter((i) => i.severity === "error").map((i) => i.message));
  // Runtime checks run for the new animation even if the project has unrelated static errors.
  const all = validateSkeleton(candidate, { loopAnimations: o.loopAnimations, runtimeAnimations: [name] });
  const ownPath = `animations/${name}`;
  const isOwn = (where?: string) => where === ownPath || Boolean(where?.startsWith(`${ownPath}/`));
  const mine = all.filter((i) => isOwn(i.where) || (i.severity === "error" && !baseline.has(i.message)));
  try {
    if (!loadSkeletonData(candidate).findAnimation(name)) throw new Error("animation not parsed");
  } catch (e) {
    mine.push({ severity: "error", code: "runtime-load", message: `spine-core could not load the new animation: ${(e as Error).message}` });
  }
  const result: AddAnimationResult = {
    mode: "dry-run", project: o.project, skeleton: target.name, name, replaced: exists,
    summary: summarizeAnimation(name, o.animation), issues: mine, preexistingErrors: baseline.size, notes: [],
  };
  const blocking = mine.filter((i) => i.severity === "error");
  if (!o.apply) {
    result.notes.push(blocking.length ? "Fix the errors before applying." : "Dry-run only. Call again with apply: true to write it (a backup is made first).");
    return result;
  }
  if (blocking.length) throw new UserError(`Not applied: ${blocking.length} error(s) in the new animation: ${blocking.slice(0, 5).map((i) => i.message).join(" | ")}`);
  if (exportCacheDir(config, o.project) !== cacheKey) throw new UserError("The project changed on disk while preparing the change; run again.");

  const backup = createBackup(config, o.project, `add_animation ${name}${exists ? " (replace)" : ""}`);
  result.backup = backup;
  const rollback = (why: string): never => {
    try {
      restoreFile(backup, o.project);
    } catch (e) {
      throw new RollbackFailed(`${why} Rolling back FAILED: ${(e as Error).message}`);
    }
    throw new RolledBack(`${why} The project was restored from backup ${backup.id}.`);
  };
  try {
    return await importAndVerify();
  } catch (e) {
    if (e instanceof RolledBack || e instanceof RollbackFailed) throw e;
    // Any unexpected failure after the backup (CLI, export, verification code) restores the project.
    return rollback(`Unexpected error during the write: ${(e as Error).message}.`);
  }

  async function importAndVerify(): Promise<AddAnimationResult> {
    const staging = join(config.workDir, "staging");
    mkdirSync(staging, { recursive: true });
    pruneDir(staging, 30);
    const stagingFile = join(staging, `${backup.id}-${target.name}.json`);
    writeFileSync(stagingFile, JSON.stringify(candidate));
    const args = ["-i", stagingFile, "-o", o.project, "--to", target.name, "-a", name, ...(exists ? ["--replace"] : []), "-r"];
    const run = await cli.run(args);
    result.cli = { seconds: run.seconds, lines: run.lines.slice(-20) };
    // Spine exits 0 even when it drops timelines or renames the animation (GOTCHAS G07, G08): any warning fails the write.
    if (cliFailed(run) || run.warnings.length) {
      rollback(`Spine import reported problems: ${[...run.errors, ...run.warnings].slice(0, 5).join(" | ") || `exit ${run.exitCode}`}.`);
    }

    let afterAll: Awaited<ReturnType<typeof loadProject>>;
    let after: SkeletonJson;
    try {
      afterAll = await loadProject(config, cli, o.project, { refresh: true });
      after = pickSkeleton(afterAll, target.name).doc;
    } catch (e) {
      return rollback(`Re-export after import failed: ${(e as Error).message}.`);
    }
    result.verification = verify(target.doc, candidate, after, name);
    // Other skeletons in the same project must be byte-identical exports.
    const beforeNames = before.skeletons.map((k) => k.name).sort().join(",");
    const afterNames = afterAll.skeletons.map((k) => k.name).sort().join(",");
    if (beforeNames !== afterNames) result.verification.differences.push(`skeleton list changed: [${beforeNames}] -> [${afterNames}]`);
    for (const other of before.skeletons.filter((k) => k.name !== target.name)) {
      const now = afterAll.skeletons.find((k) => k.name === other.name);
      if (now && JSON.stringify(now.doc) !== JSON.stringify(other.doc)) result.verification.differences.push(`skeleton "${other.name}" changed`);
    }
    if (result.verification.differences.length) rollback(`Verification failed: ${result.verification.differences.slice(0, 5).join(" | ")}.`);

    result.mode = "applied";
    result.notes.push(EDITOR_NOTE, `Undo with spine_restore_backup (backupId ${backup.id}).`);
    return result;
  }
}

function verify(before: SkeletonJson, candidate: SkeletonJson, after: SkeletonJson, name: string): Verification {
  const differences: string[] = [];
  const mine = compareAnimationAcrossDocs(candidate, after, name);
  differences.push(...mine.differences.map((d) => `${name}: ${d}`));

  const beforeNames = Object.keys(before.animations ?? {}).filter((n) => n !== name);
  const afterNames = Object.keys(after.animations ?? {}).filter((n) => n !== name);
  const added = afterNames.filter((n) => !beforeNames.includes(n));
  const removed = beforeNames.filter((n) => !afterNames.includes(n));
  if (added.length) differences.push(`unexpected animations: ${added.join(", ")}`);
  if (removed.length) differences.push(`missing animations: ${removed.join(", ")}`);
  let othersOk = !added.length && !removed.length;
  let beforeData: ReturnType<typeof loadSkeletonData> | undefined;
  let afterData: ReturnType<typeof loadSkeletonData> | undefined;
  for (const n of beforeNames.filter((x) => afterNames.includes(x))) {
    if (JSON.stringify(before.animations![n]) === JSON.stringify(after.animations![n])) continue;
    // Formatting can differ across editor builds; fall back to a semantic comparison.
    beforeData ??= loadSkeletonData(before);
    afterData ??= loadSkeletonData(after);
    const d = compareAnimations(beforeData.findAnimation(n)!, afterData.findAnimation(n)!, { a: beforeData, b: afterData });
    if (!d.equal) {
      othersOk = false;
      differences.push(`${n} changed: ${d.differences.slice(0, 3).join("; ")}`);
    }
  }
  const structural = exportsEqual(before, after);
  if (structural.length) differences.push(`skeleton sections changed: ${structural.join(", ")}`);
  return { animationMatches: mine.equal, otherAnimationsUnchanged: othersOk, structureUnchanged: !structural.length, differences };
}

/**
 * Spine's import stores bone rotate, translate and shear values smaller than 0.005 as 0 (G84, G97); writing them as
 * Spine will keep them lets the re-export compare like for like.
 */
export function zeroTinyValues(anim: AnimationJson): AnimationJson {
  const out = structuredClone(anim);
  for (const tl of Object.values(out.bones ?? {})) {
    for (const [prop, keys] of Object.entries(tl)) {
      if (!/^(rotate|translate|translatex|translatey|shear|shearx|sheary)$/.test(prop)) continue;
      for (const k of keys) for (const f of ["value", "x", "y"]) if (typeof k[f] === "number" && k[f] !== 0 && Math.abs(k[f] as number) < 0.005) k[f] = 0;
    }
  }
  return out;
}
