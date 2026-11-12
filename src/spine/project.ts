import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import { BinaryInput } from "@esotericsoftware/spine-core";
import type { Config } from "../config.js";
import { cliFailed, type CliResult, type SpineCli } from "./cli.js";
import type { SkeletonJson } from "./types.js";
import { fileKey, isLockError, readJson, removeQuiet, retryLocked } from "../platform.js";

export interface LoadedSkeleton {
  /** Skeleton name (the exported file name without extension). */
  name: string;
  jsonPath: string;
  doc: SkeletonJson;
}

export interface LoadResult {
  input: string;
  kind: "spine" | "json" | "skel";
  skeletons: LoadedSkeleton[];
  /** Set when the project had to be exported (absent on cache hits and JSON input). */
  export?: CliResult;
  cached: boolean;
  /**
   * Binary data: the Spine version in its own header. The exported JSON carries the version of the CLI that exported
   * it instead (4.3.23 data reads as 4.3.26).
   */
  sourceVersion?: string;
}

/** The Spine version a binary skeleton was exported with, from its header (hash, then the version string); null if unreadable. */
export function skelDataVersion(file: string): string | null {
  try {
    // A copy: BinaryInput reads the whole underlying buffer, and Node keeps small files in a shared pool.
    const input = new BinaryInput(Uint8Array.from(readFileSync(file).subarray(0, 64)));
    input.readInt32();
    input.readInt32();
    const v = input.readString();
    return v && /^\d+\.\d+(\.\d+)?/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export class UserError extends Error {}

/** The file's kind by extension; a Unity project's binary data is `.skel.bytes`. */
export function inputExt(path: string): string {
  const lower = path.toLowerCase();
  return lower.endsWith(".skel.bytes") ? ".skel.bytes" : extname(lower);
}

const SKEL_EXTS = [".skel", ".skel.bytes"];

export function assertInputPath(path: string, allowed: string[] = [".spine", ".json", ...SKEL_EXTS]): string {
  if (!isAbsolute(path)) throw new UserError(`Path must be absolute (Spine resolves relative paths from the project folder): ${path}`);
  if (!existsSync(path)) throw new UserError(`Path does not exist: ${path}`);
  if (!allowed.includes(inputExt(path))) throw new UserError(`Expected ${allowed.join(" or ")} file: ${path}`);
  return path;
}

export function readSkeletonJson(path: string): SkeletonJson {
  const doc = readJson<SkeletonJson>(path);
  if (!doc || typeof doc !== "object" || !doc.skeleton || !Array.isArray(doc.bones)) {
    throw new UserError(`Not a Spine skeleton JSON (missing skeleton/bones): ${path}`);
  }
  return doc;
}

/** Cache folder for one project state: changes whenever the .spine file is saved. */
export function exportCacheDir(config: Config, projectPath: string): string {
  const real = fileKey(projectPath);
  const st = statSync(realpathSync(projectPath));
  const key = createHash("sha1").update(`${real}|${st.mtimeMs}|${st.ctimeMs}|${st.size}|${config.spineBin}|${config.spineVersion}`).digest("hex").slice(0, 16);
  return join(config.workDir, "exports", `${skeletonFileName(projectPath)}-${key}`);
}

/** Keeps the `keep` most recently modified entries of a cache folder and deletes the rest. */
export function pruneDir(dir: string, keep: number, match?: RegExp): void {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir)
    .filter((n) => !match || match.test(n))
    .map((n) => { try { return { path: join(dir, n), mtime: statSync(join(dir, n)).mtimeMs }; } catch { return null; } })
    .filter((e): e is { path: string; mtime: number } => e !== null)
    .sort((a, b) => b.mtime - a.mtime);
  // An entry another call or program still holds stays for the next prune (Windows), it never fails this call.
  for (const e of entries.slice(keep)) removeQuiet(e.path);
}

function listJson(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => join(dir, f)) : [];
}

/** The file name without its Spine extension (`hero.spine`, `hero.skel`, `hero.skel.bytes` → `hero`). */
const skeletonFileName = (path: string) => basename(path).slice(0, basename(path).length - inputExt(path).length);

/**
 * Loads every skeleton of a `.spine` project or of binary skeleton data (`.skel`, or Unity's `.skel.bytes`), exported
 * to JSON through the CLI and cached by file state, or a single skeleton `.json`. Read-only: never writes next to the
 * input.
 */
const inFlight = new WeakMap<SpineCli, Map<string, Promise<LoadResult>>>();

export async function loadProject(config: Config, cli: SpineCli, input: string, opts: { refresh?: boolean } = {}): Promise<LoadResult> {
  assertInputPath(input);
  if (inputExt(input) === ".json") return loadProjectOnce(config, cli, input, opts);
  let pending = inFlight.get(cli);
  if (!pending) { pending = new Map(); inFlight.set(cli, pending); }
  const key = exportCacheDir(config, input);
  const prior = pending.get(key);
  if (prior) return structuredClone(await prior);
  const work = loadProjectOnce(config, cli, input, opts);
  pending.set(key, work);
  try { return await work; } finally { pending.delete(key); }
}

async function loadProjectOnce(config: Config, cli: SpineCli, input: string, opts: { refresh?: boolean } = {}): Promise<LoadResult> {
  assertInputPath(input);
  const ext = inputExt(input);
  if (ext === ".json") {
    return { input, kind: "json", cached: false, skeletons: [{ name: basename(input, ".json"), jsonPath: input, doc: readSkeletonJson(input) }] };
  }
  const dir = exportCacheDir(config, input);
  let files = opts.refresh ? [] : listJson(dir);
  let exportResult: CliResult | undefined;
  const cached = files.length > 0;
  if (!cached) {
    pruneDir(join(config.workDir, "exports"), 60);
    // Export into a temp folder and rename it into place only on success, so a failed or partial export
    // never looks like a cache hit.
    const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
    mkdirSync(tmp, { recursive: true });
    // The CLI exports a .skel directly but refuses Unity's .skel.bytes: hand it a .skel copy outside the output folder.
    let source = input, copy: string | undefined;
    if (ext === ".skel.bytes") {
      copy = `${tmp}-src`;
      mkdirSync(copy, { recursive: true });
      source = join(copy, `${skeletonFileName(input)}.skel`);
      copyFileSync(input, source);
    }
    try {
      exportResult = await cli.run(["-i", source, "-o", tmp, "-e", "json"]);
    } finally {
      if (copy) removeQuiet(copy);
    }
    const produced = listJson(tmp);
    if (cliFailed(exportResult) || produced.length === 0) {
      rmSync(tmp, { recursive: true, force: true });
      throw new UserError(`Spine JSON export failed (exit ${exportResult.exitCode}): ${[...exportResult.errors, ...exportResult.lines.slice(-3)].join(" | ") || "no JSON produced"}`);
    }
    // Windows: a folder another program holds (antivirus scanning the new files) cannot be renamed or replaced for a
    // moment; then the cache is skipped this time and the export read where it is.
    try {
      retryLocked(() => { rmSync(dir, { recursive: true, force: true }); renameSync(tmp, dir); });
      files = listJson(dir);
    } catch (e) {
      if (isLockError(e)) {
        // The old cache may be half removed (a recursive remove stops at the locked file): read the complete export.
        files = listJson(tmp);
      } else if (["ENOTEMPTY", "EEXIST"].includes((e as NodeJS.ErrnoException).code ?? "")) {
        // Another loader put its export in place first.
        files = listJson(dir).length ? listJson(dir) : listJson(tmp);
      } else throw e;
    }
  }
  const sourceVersion = ext === ".spine" ? null : skelDataVersion(input);
  return {
    input, kind: ext === ".spine" ? "spine" : "skel", cached, export: exportResult, ...(sourceVersion ? { sourceVersion } : {}),
    skeletons: files.map((f) => ({ name: basename(f, ".json"), jsonPath: f, doc: readSkeletonJson(f) })),
  };
}

export function pickSkeleton(result: LoadResult, name?: string): LoadedSkeleton {
  if (name) {
    const s = result.skeletons.find((k) => k.name === name);
    if (!s) throw new UserError(`Skeleton "${name}" not found. Available: ${result.skeletons.map((k) => k.name).join(", ")}`);
    return s;
  }
  if (result.skeletons.length > 1) {
    throw new UserError(`Project has ${result.skeletons.length} skeletons; pass "skeleton": ${result.skeletons.map((k) => k.name).join(", ")}`);
  }
  return result.skeletons[0]!;
}
