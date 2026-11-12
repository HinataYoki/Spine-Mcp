import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import type { Config } from "../config.js";
import { createBackup } from "./backup.js";
import type { SpineCli } from "./cli.js";
import { compareAnimationAcrossDocs } from "./compare.js";
import { importSteps, stagingPathFor, stagingStale } from "./editor.js";
import { loadProject, pickSkeleton, UserError } from "./project.js";
import type { AnimationJson, SkeletonJson } from "./types.js";
import { addAnimationLocked, type AddAnimationOptions, type AddAnimationResult } from "./write.js";
import { fileKeyOr } from "../platform.js";

/** What spine-mcp wrote into a staging copy, so pending work is told apart from the user's own edits. */
interface StagingEntry {
  skeleton: string;
  name: string;
  /** The animation as Spine exported it from the staging copy after the verified write. */
  staged: AnimationJson;
  /** The project's own version at write time (JSON), null when the project did not have it: tells "not imported yet" from "changed in the editor". */
  projectAtWrite: string | null;
  writtenAt: string;
}

interface StagingManifest {
  project: string;
  staging: string;
  entries: StagingEntry[];
}

export interface StagingState {
  pending: { skeleton: string; animations: string[] }[];
  /** Now in the project exactly as verified: done. */
  imported: string[];
  /** The project changed them (or deleted them) since spine-mcp wrote them: no longer offered. */
  changed: string[];
}

const real = (p: string) => fileKeyOr(p);
/** The real path of a file that may not exist yet (its folder must). */
const realFile = (p: string) => { const f = join(real(dirname(p)), basename(p)); return process.platform === "win32" ? f.toLowerCase() : f; };
const manifestPath = (config: Config, staging: string) => join(config.workDir, "editor-staging", `${createHash("sha1").update(realFile(staging)).digest("hex").slice(0, 16)}.json`);

function readManifest(config: Config, project: string, staging: string): StagingManifest {
  const p = manifestPath(config, staging);
  if (existsSync(p)) {
    try {
      const m = JSON.parse(readFileSync(p, "utf8")) as StagingManifest;
      if (m.project === real(project)) return m;
    } catch { /* unreadable: start over */ }
  }
  return { project: real(project), staging: realFile(staging), entries: [] };
}

function writeManifest(config: Config, m: StagingManifest): void {
  const p = manifestPath(config, m.staging);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(m));
}

/** The staging copy to use, refusing paths that would hit the project itself or a file spine-mcp did not create. */
export function resolveStagingPath(config: Config, project: string, wanted?: string): string {
  const staging = wanted ?? stagingPathFor(project);
  if (!isAbsolute(staging) || extname(staging).toLowerCase() !== ".spine") throw new UserError(`stagingPath must be an absolute path to a .spine file: ${staging}`);
  if (!existsSync(dirname(staging)) || !statSync(dirname(staging)).isDirectory()) throw new UserError(`stagingPath folder does not exist: ${dirname(staging)}`);
  if (realFile(staging) === real(project)) throw new UserError("stagingPath is the project itself; the staging copy must be a separate file.");
  if (existsSync(staging) && wanted) {
    const ours = existsSync(manifestPath(config, staging)) && readManifest(config, project, staging).staging === realFile(staging) && JSON.parse(readFileSync(manifestPath(config, staging), "utf8")).project === real(project);
    if (!ours && realFile(staging) !== realFile(stagingPathFor(project))) throw new UserError(`${staging} already exists and is not a spine-mcp staging copy of this project; choose a new file.`);
  }
  return staging;
}

export const stagingLockKey = (staging: string) => `staging:${realFile(staging)}`;

function sameAnimation(projectDoc: SkeletonJson, name: string, staged: AnimationJson): boolean {
  const mine = projectDoc.animations?.[name];
  if (!mine) return false;
  if (JSON.stringify(mine) === JSON.stringify(staged)) return true;
  return compareAnimationAcrossDocs({ ...projectDoc, animations: { ...projectDoc.animations, [name]: staged } }, projectDoc, name).equal;
}

/** Sorts the manifest against the project as saved now: pending stays, imported and changed entries leave the manifest. */
async function classify(config: Config, cli: SpineCli, project: string, m: StagingManifest) {
  const proj = await loadProject(config, cli, project);
  const pending: StagingEntry[] = [], imported: string[] = [], changed: string[] = [];
  for (const e of m.entries) {
    const doc = proj.skeletons.find((k) => k.name === e.skeleton)?.doc;
    const id = `${e.skeleton}/${e.name}`;
    if (!doc) { changed.push(id); continue; }
    const now = doc.animations?.[e.name];
    if (now && sameAnimation(doc, e.name, e.staged)) imported.push(id);
    else if (!now && e.projectAtWrite === null) pending.push(e);
    else if (now && e.projectAtWrite !== null && JSON.stringify(now) === e.projectAtWrite) pending.push(e); // a replacement not imported yet
    else changed.push(id); // edited or deleted in the editor since
  }
  return { proj, pending, imported, changed };
}

const groups = (entries: StagingEntry[]) => {
  const by = new Map<string, string[]>();
  for (const e of entries) (by.get(e.skeleton) ?? by.set(e.skeleton, []).get(e.skeleton)!).push(e.name);
  return [...by].map(([skeleton, animations]) => ({ skeleton, animations }));
};

/** Pending, imported and changed animations of a staging copy (also prunes what is done). */
export async function stagingState(config: Config, cli: SpineCli, project: string, staging: string): Promise<StagingState> {
  const m = readManifest(config, project, staging);
  const c = await classify(config, cli, project, m);
  if (c.imported.length || c.changed.length) writeManifest(config, { ...m, entries: c.pending });
  return { pending: groups(c.pending), imported: c.imported, changed: c.changed };
}

/**
 * A verified write into the staging copy. A copy older than the project (the user saved in the editor) is rebuilt in a
 * scratch file from the saved project plus the animations still pending; the copy is replaced only when everything,
 * the new write included, succeeded.
 */
export async function stagedWrite(config: Config, cli: SpineCli, o: AddAnimationOptions, staging: string): Promise<AddAnimationResult> {
  const name = o.name.trim();
  const m = readManifest(config, o.project, staging);
  const c = await classify(config, cli, o.project, m);
  const skeleton = pickSkeleton(c.proj, o.skeleton).name;
  const same = (e: StagingEntry) => e.skeleton === skeleton && e.name === name;
  const pendingHere = c.pending.find(same);
  if (pendingHere && !o.replace) throw new UserError(`"${name}" is already waiting in the staging copy for Import Project. Pass replace: true to overwrite the staged version, or pick a new name.`);
  const carried: string[] = [], dropped: string[] = [];
  const stale = stagingStale(o.project, staging);
  let result: AddAnimationResult;
  if (!stale) {
    result = await addAnimationLocked(config, cli, { ...o, project: staging, replace: o.replace || !!pendingHere });
  } else {
    const build = join(config.workDir, "editor-staging", `build-${Date.now()}-${process.pid}.spine`);
    mkdirSync(dirname(build), { recursive: true });
    copyFileSync(o.project, build);
    try {
      for (const e of c.pending.filter((x) => !same(x))) {
        try {
          await addAnimationLocked(config, cli, { project: build, skeleton: e.skeleton, name: e.name, animation: e.staged, apply: true, replace: true });
          carried.push(`${e.skeleton}/${e.name}`);
        } catch {
          dropped.push(`${e.skeleton}/${e.name}`);
        }
      }
      result = await addAnimationLocked(config, cli, { ...o, skeleton, project: build });
      if (existsSync(staging)) createBackup(config, staging, "staging copy before rebuild");
      copyFileSync(build, staging);
    } finally {
      rmSync(build, { force: true });
    }
    result.backup = undefined; // the scratch file's backup means nothing to the user
  }
  result.project = staging;

  // Record what was verified, as Spine exported it from the staging copy.
  const stagedDoc = pickSkeleton(await loadProject(config, cli, staging), skeleton).doc;
  const projectDoc = pickSkeleton(c.proj, skeleton).doc;
  const projectNow = projectDoc.animations?.[name];
  const keep = c.pending.filter((e) => !same(e) && !dropped.includes(`${e.skeleton}/${e.name}`));
  const entries: StagingEntry[] = [...keep, {
    skeleton, name, staged: stagedDoc.animations![name]!,
    projectAtWrite: pendingHere ? pendingHere.projectAtWrite : projectNow ? JSON.stringify(projectNow) : null,
    writtenAt: new Date().toISOString(),
  }];
  writeManifest(config, { ...m, staging: realFile(staging), entries });
  const pending = groups(entries);
  result.staged = {
    project: o.project, stagedProject: staging, reused: !stale, pending,
    ...(carried.length ? { carried } : {}), ...(dropped.length ? { dropped } : {}),
    ...(c.imported.length ? { imported: c.imported } : {}), ...(c.changed.length ? { changed: c.changed } : {}),
    importSteps: importSteps(staging, pending),
  };
  return result;
}

/** Cheap view of a staging copy for status (no CLI): what spine-mcp wrote into it, not yet checked against the project. */
export function stagingSnapshot(config: Config, project: string, staging = stagingPathFor(project)) {
  const exists = existsSync(staging);
  const m = readManifest(config, project, staging);
  if (!exists && !m.entries.length) return undefined;
  return { staging, exists, olderThanProject: exists && stagingStale(project, staging), written: groups(m.entries) };
}
