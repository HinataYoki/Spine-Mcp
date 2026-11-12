import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config } from "../config.js";
import { sha256File } from "./backup.js";
import { fileKeyOr } from "../platform.js";

/**
 * What spine-mcp did to a project, one JSON line per step, kept in the work dir (never next to the project).
 * A log for resuming work and spotting outside edits, not an undo: backups stay the way back.
 */
export interface TrajectoryStep {
  at: string;
  tool: string;
  /** Short human summary, e.g. "walk", "offsetBones from idle". */
  detail?: string;
  outcome: "applied" | "staged" | "rolledBack" | "restored" | "created" | "imagesUpdated" | "imagesRestored" | "snapshot";
  skeleton?: string;
  animation?: string;
  replaced?: boolean;
  /** Animation duration and key count of what was written. */
  duration?: number;
  keys?: number;
  backupId?: string;
  /** The staging copy the change went to (editor open). */
  staged?: string;
  /** The project file's sha256 after the step: tells later whether someone changed the file since. */
  sha256?: string;
  error?: string;
}

/** Steps kept per project; older ones are dropped. */
const KEEP = 300;

const real = (p: string) => fileKeyOr(p);

/** Same per-project key as the backups folder. */
export function trajectoryFile(config: Config, project: string): string {
  const key = createHash("sha1").update(real(project)).digest("hex").slice(0, 10);
  return join(config.workDir, "trajectory", `${basename(project, ".spine")}-${key}.jsonl`);
}

/** Appends one step. Never throws: a log failure must not fail (or roll back) a verified write. */
export function recordStep(config: Config, project: string, step: Omit<TrajectoryStep, "at" | "sha256"> & { sha256?: string }): void {
  try {
    const file = trajectoryFile(config, project);
    mkdirSync(dirname(file), { recursive: true });
    const sha256 = step.sha256 ?? (existsSync(project) ? sha256File(project) : undefined);
    const entry: TrajectoryStep = { at: new Date().toISOString(), ...step, ...(sha256 ? { sha256 } : {}) };
    appendFileSync(file, JSON.stringify(entry) + "\n");
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length > KEEP * 1.2) writeFileSync(file, lines.slice(-KEEP).join("\n") + "\n");
  } catch { /* best effort */ }
}

/** All logged steps, oldest first (unreadable lines skipped). */
export function readTrajectory(config: Config, project: string): TrajectoryStep[] {
  const file = trajectoryFile(config, project);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l) as TrajectoryStep];
    } catch {
      return [];
    }
  });
}
