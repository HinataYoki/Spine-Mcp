import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { baseName, fileKeyOr, processList, spineUserDir, splitCommandLine } from "../platform.js";

export interface SpineProcess {
  pid: number;
  args: string;
}

export interface EditorStatus {
  /** A Spine editor window (not a CLI run) is open. */
  running: boolean;
  /** The process list could not be read: whether an editor is open is unknown (writes go to the staging copy). */
  unknown?: true;
  pids: number[];
  /** Most recently opened project according to Spine's recent-files list (a hint, not proof it is open now). */
  lastOpenedProject?: string;
  /** For a given project: "likely" when the editor runs and this was the last project it opened, "possible" when the editor runs, "no" otherwise. */
  projectOpen?: "likely" | "possible" | "no";
}

export type EditorMode = "auto" | "staging" | "inPlace";

// CLI runs always carry one of these; an editor window is the launcher with no arguments, a version pin or a project path.
const CLI_FLAGS = new Set(["-i", "--input", "-e", "--export", "-o", "--output", "-p", "--pack", "-v", "--version", "-h", "--help", "-a", "--to", "-r", "--clean"]);

let listProcesses = (): SpineProcess[] | null => processList();

/** Tests swap the process lister (null: the list could not be read) and Spine's settings folder. */
export function setEditorProbe(probe: { processes?: () => SpineProcess[] | null; settingsDir?: string }) {
  if (probe.processes) listProcesses = probe.processes;
  if (probe.settingsDir !== undefined) settingsDirOverride = probe.settingsDir;
}
let settingsDirOverride: string | undefined;

export function isEditorProcess(p: SpineProcess, spineBin: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") {
    // The editor is Spine.exe (GUI) or the Spine.com launcher, quoted when the path has spaces; a Java process
    // running Spine counts too (not verified how the Windows launcher starts the editor: a false match only sends
    // writes to the staging copy).
    const { exe, rest } = splitCommandLine(p.args);
    const name = baseName(exe).toLowerCase();
    const spine = name === "spine.exe" || name === "spine.com" || exe.toLowerCase() === spineBin.toLowerCase()
      || ((name === "java.exe" || name === "javaw.exe") && /[\\/]spine[\\/]/i.test(p.args));
    return spine && !rest.trim().split(/\s+/).filter(Boolean).some((a) => CLI_FLAGS.has(a));
  }
  const m = new RegExp(`(?:^|\\s)(${escape(spineBin)}|\\S*/Spine\\.app/Contents/MacOS/Spine)(?=\\s|$)`).exec(p.args);
  if (!m) return false;
  const args = p.args.slice(m.index + m[0].length).trim().split(/\s+/).filter(Boolean);
  return !args.some((a) => CLI_FLAGS.has(a));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function lastOpenedProject(): string | undefined {
  // Windows and Linux: Esoteric's documented Spine folder plus the settings subfolder newer editors use (not verified
  // on those systems; a miss only loses the "likely" hint).
  const dir = settingsDirOverride ?? join(spineUserDir(), "settings");
  const file = join(dir, "recent-1.json");
  if (!existsSync(file)) return undefined;
  try {
    const text = readFileSync(file, "utf8");
    const at = text.indexOf("projectFile:");
    if (at < 0) return undefined;
    const path = /path:"([^"]+\.spine)"/.exec(text.slice(at))?.[1];
    return path?.replace(/\\\\/g, "\\"); // a Windows path escaped in the JSON
  } catch {
    return undefined;
  }
}

const real = (p: string) => fileKeyOr(p);

export function editorStatus(spineBin: string, project?: string): EditorStatus {
  const list = listProcesses();
  const pids = (list ?? []).filter((p) => isEditorProcess(p, spineBin)).map((p) => p.pid);
  const running = pids.length > 0;
  const last = running || !list ? lastOpenedProject() : undefined;
  const status: EditorStatus = { running, pids, ...(list ? {} : { unknown: true as const }), ...(last ? { lastOpenedProject: last } : {}) };
  if (project) status.projectOpen = !running && list ? "no" : last && real(last) === real(project) ? "likely" : "possible";
  return status;
}

/** Whether a write should go to a staging copy instead of the project itself. */
export function useStaging(mode: EditorMode | undefined, status: EditorStatus): boolean {
  if (mode === "staging") return true;
  if (mode === "inPlace") return false;
  // Unknown counts as open: a write the editor would overwrite on save is worse than a staging copy to import.
  return status.running || !!status.unknown;
}

/** `<name>-mcp-staging.spine` next to the project (relative image paths keep working). */
export function stagingPathFor(project: string): string {
  return join(dirname(project), `${basename(project, ".spine")}-mcp-staging.spine`);
}

/** The staging copy must be rebuilt when missing or older than the project (the user saved in the editor since). */
export function stagingStale(project: string, staging: string): boolean {
  return !existsSync(staging) || statSync(staging).mtimeMs < statSync(project).mtimeMs;
}

export function importSteps(staging: string, pending: { skeleton: string; animations: string[] }[]): string[] {
  return [
    `In the Spine editor: main menu (Spine logo) > Import Project, choose ${staging}.`,
    ...pending.map((g) => `Skeleton "${g.skeleton}" (source and target): tick ${g.animations.join(", ")}.`),
    "Keep 'Replace existing' off unless an animation of the same name should be overwritten; then save.",
    "Afterwards spine_editor_status with the project confirms the import matches the verified copy.",
  ];
}

export const EDITOR_UNKNOWN_NOTE = "Could not read the process list, so whether a Spine editor window is open is unknown: writes go to the verified staging copy (editor: inPlace overrides once you know the editor is closed).";

export const EDITOR_OPEN_NOTE = "A Spine editor window is open. Changes written to a .spine file while it is open in the editor are not picked up by the editor, and saving there afterwards replaces them (Spine forum, spine-editor issue #470; not re-verified on 4.3.26). Reopen the project before editing.";
