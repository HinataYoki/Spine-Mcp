import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Config } from "../config.js";
import { fileKey, isLockError, replaceFile, type ReplaceOps } from "../platform.js";
import { UserError } from "./project.js";

export interface BackupEntry {
  id: string;
  project: string;
  file: string;
  sha256: string;
  size: number;
  createdAt: string;
  reason: string;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Per-project folder inside the work dir; backups never land next to the user's project. */
function backupDir(config: Config, project: string): string {
  const key = createHash("sha1").update(fileKey(project)).digest("hex").slice(0, 10);
  return join(config.workDir, "backups", `${basename(project, ".spine")}-${key}`);
}

export function createBackup(config: Config, project: string, reason: string): BackupEntry {
  const dir = backupDir(config, project);
  mkdirSync(dir, { recursive: true });
  // Millisecond stamp plus a counter so two backups in the same millisecond never collide.
  let id = new Date().toISOString().replace(/[:.]/g, "-");
  for (let n = 2; existsSync(join(dir, `${id}.spine`)); n++) id = `${id.replace(/_\d+$/, "")}_${n}`;
  const file = join(dir, `${id}.spine`);
  copyFileSync(project, file);
  const entry: BackupEntry = { id, project, file, sha256: sha256File(file), size: statSync(file).size, createdAt: new Date().toISOString(), reason };
  if (entry.sha256 !== sha256File(project)) throw new UserError(`Backup verification failed for ${project}`);
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(entry, null, 2));
  return entry;
}

export function listBackups(config: Config, project: string): BackupEntry[] {
  const dir = backupDir(config, project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as BackupEntry)
    .filter((e) => existsSync(e.file))
    .sort((a, b) => b.id.localeCompare(a.id));
}

const FS_OPS: ReplaceOps = { rename: renameSync, copy: copyFileSync, remove: (p) => rmSync(p, { force: true }) };

/**
 * Puts a backup back in place: copied to a temp file beside the project, then renamed over it (atomic). While another
 * program holds the project (Windows: a sync client, antivirus, an editor), the rename is retried, then the bytes are
 * copied over it. If that fails too, the error says so and where the backup is: never a restore that did not happen.
 */
export function restoreFile(entry: BackupEntry, project: string, ops: ReplaceOps = FS_OPS): void {
  if (sha256File(entry.file) !== entry.sha256) throw new UserError(`Backup ${entry.id} is corrupted (hash mismatch)`);
  const tmp = join(dirname(project), `.${basename(project)}.spine-mcp-restore`);
  copyFileSync(entry.file, tmp);
  try {
    replaceFile(tmp, project, ops);
  } catch (e) {
    const why = isLockError(e) ? `another program holds the file (${(e as NodeJS.ErrnoException).code}: a sync client, antivirus or an editor)` : (e as Error).message;
    throw new UserError(`Could not put backup ${entry.id} back over ${project}: ${why}. The project is NOT restored. The backup is ${entry.file}: close the program holding the project, then run spine_restore_backup with backupId "${entry.id}" (or copy that file over the project).`);
  }
  if (sha256File(project) !== entry.sha256) throw new UserError(`Restore of ${entry.id} did not verify: the project is not the backup. The backup is ${entry.file}.`);
}
