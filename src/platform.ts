// Everything that differs between macOS, Linux and Windows. Functions take the platform (and environment) so the
// Windows branches run in unit tests on any machine; the Windows CI job runs the real thing.
import { createHash } from "node:crypto";
import * as cp from "node:child_process";
import { readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { promisify } from "node:util";

export interface ProcessInfo {
  pid: number;
  /** The full command line (executable and arguments). */
  args: string;
}

// PowerShell writes the console code page by default: UTF-8 keeps non-ASCII paths (a "Işık" profile folder) intact.
const PS_LIST = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }";

/** "pid command line" per line, as `ps -axo pid=,args=` and the PowerShell listing print them. */
export function parseProcessList(out: string): ProcessInfo[] {
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^(\d+)\s*(.*)$/.exec(l);
    return m ? { pid: Number(m[1]), args: m[2]! } : null;
  }).filter((p): p is ProcessInfo => p !== null);
}

/**
 * Running processes with their command lines, or null when the list could not be read. Callers must treat null as
 * "unknown", never as "nothing running": the editor checks guard against writing a file an editor has open.
 */
export function processList(platform: NodeJS.Platform = process.platform): ProcessInfo[] | null {
  try {
    const out = platform === "win32"
      ? cp.execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_LIST], { encoding: "utf8", timeout: 20_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
      : cp.execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf8", timeout: 5_000, maxBuffer: 32 * 1024 * 1024 });
    const list = parseProcessList(out);
    return list.length ? list : null; // an empty list means the probe failed (this process itself is running)
  } catch {
    return null;
  }
}

/**
 * The executable at the start of a command line, quoted or not, and the arguments after it. Windows command lines
 * quote paths with spaces ("C:\Program Files\Spine\Spine.exe" ...); unquoted ones end at the first space.
 */
export function splitCommandLine(args: string): { exe: string; rest: string } {
  const s = args.trimStart();
  if (s.startsWith("\"")) {
    const end = s.indexOf("\"", 1);
    return end < 0 ? { exe: s.slice(1), rest: "" } : { exe: s.slice(1, end), rest: s.slice(end + 1) };
  }
  const sp = s.search(/\s/);
  return sp < 0 ? { exe: s, rest: "" } : { exe: s.slice(0, sp), rest: s.slice(sp) };
}

/** The file name of a path in either separator style. */
export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Windows refuses to replace, rename or delete a file another program holds open (sync clients, antivirus, an editor). */
export const isLockError = (e: unknown) => ["EPERM", "EACCES", "EBUSY"].includes((e as NodeJS.ErrnoException)?.code ?? "");

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `fn`, retrying lock errors with a growing pause (about 2.5 s in all); other errors are thrown at once. */
export function retryLocked<T>(fn: () => T, attempts = 8): T {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (e) {
      if (!isLockError(e) || i >= attempts) throw e;
      pause(Math.min(50 * 2 ** (i - 1), 800));
    }
  }
}

export interface ReplaceOps {
  rename: (from: string, to: string) => void;
  copy: (from: string, to: string) => void;
  remove: (path: string) => void;
}

/**
 * Puts `tmp` in place of `dest`: a rename (atomic), retried while something holds the file; if the rename keeps
 * failing (Windows cannot rename over a file open without delete sharing), the bytes are copied over `dest` instead.
 * Throws when both fail; `tmp` is removed either way.
 */
export function replaceFile(tmp: string, dest: string, ops: ReplaceOps): void {
  try {
    try {
      retryLocked(() => ops.rename(tmp, dest));
      return;
    } catch (e) {
      if (!isLockError(e)) throw e;
    }
    retryLocked(() => ops.copy(tmp, dest));
  } finally {
    try { ops.remove(tmp); } catch { /* already moved, or held: a leftover temp file only */ }
  }
}

/**
 * Deletes a temp file or folder, retrying while a just-exited process (a Spine JVM, Unity's import workers) still
 * holds it, and never throws: cleanup must not turn a finished result into an error. What stays is a cache leftover.
 */
export function removeQuiet(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // held by a process that has not exited yet
  }
}

/**
 * The key one file is known by (backups, step log, write lock, staging, caches). macOS and Linux: its real path, as
 * before. Windows: the real path from the file system (`realpathSync.native` expands 8.3 short names and takes the
 * on-disk case), lower-cased, since C:\P\Hero.spine and c:\p\hero.spine are the same file there.
 */
export function fileKey(path: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? realpathSync.native(path).toLowerCase() : realpathSync(path);
}

/** fileKey, or the path itself (lower-cased on Windows) when it does not exist. */
export function fileKeyOr(path: string, platform: NodeJS.Platform = process.platform): string {
  try {
    return fileKey(path, platform);
  } catch {
    return platform === "win32" ? path.toLowerCase() : path;
  }
}

/** A path inside a Unity project as Unity writes it ("Assets/Spine/hero"): forward slashes on every platform. */
export const unityPath = (rel: string) => rel.split(/[\\/]/).join("/");

/**
 * A folder name for an animation's renders, the same in TypeScript and in the Unity script (SpineMcpCheck.RenderFolder):
 * a plain name (letters, digits, _ . -, up to 60, not ending in a dot) as it is, anything else as the hex of its UTF-8
 * bytes. Windows forbids \ / : * ? " < > | and a trailing dot; hex needs no shared regex flavour. Hex longer than
 * 120 keeps its first 88 digits and adds the first 16 of the name's SHA-1, so long names sharing a start stay apart.
 */
export function renderFolder(name: string): string {
  if (/^[A-Za-z0-9_.-]{1,60}$/.test(name) && !name.endsWith(".")) return name;
  const hex = Buffer.from(name, "utf8").toString("hex");
  return hex.length <= 120 ? `x${hex}` : `x${hex.slice(0, 88)}-${createHash("sha1").update(name, "utf8").digest("hex").slice(0, 16)}`;
}

/** Parses a JSON file that a Windows editor (Notepad, PowerShell 5) may have saved with a byte order mark. */
export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as T;
}

/** Text with Windows line endings (a Git checkout with autocrlf, a Windows editor) as LF. */
export const lf = (text: string) => text.replace(/\r\n/g, "\n");

// Child processes: no console window on Windows. A GUI host (Claude Desktop) starts the server without a console, so
// each console program (Spine.com, magick, ffmpeg, Unity) would otherwise flash one.

/** child_process.execFileSync with windowsHide. */
export const execFileSync = ((file: string, args?: readonly string[], options?: cp.ExecFileSyncOptions) =>
  cp.execFileSync(file, args, { windowsHide: true, ...options })) as typeof cp.execFileSync;

/** child_process.spawn with windowsHide. */
export const spawn = ((command: string, args: readonly string[], options: cp.SpawnOptions = {}) =>
  cp.spawn(command, args, { windowsHide: true, ...options })) as typeof cp.spawn;

/**
 * Ends a process and everything it started. Windows: taskkill /T (Spine.com's Java editor, Unity's import workers and
 * shader compilers would otherwise keep running and hold files); elsewhere the signal, as before.
 */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM", platform: NodeJS.Platform = process.platform): void {
  if (!pid) return;
  try {
    if (platform === "win32") cp.execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 15_000 });
    else process.kill(pid, signal);
  } catch {
    // already gone
  }
}

const execFileAsync = promisify(cp.execFile);

/**
 * Runs a program to completion (stdout and stderr as text), like promisify(execFile), without a console window. On
 * timeout the whole process tree is ended (Windows) and the promise rejects with `killed: true`.
 */
export function runFile(file: string, args: string[], options: { timeout?: number; maxBuffer?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string }> {
  const { timeout, ...rest } = options;
  const p = execFileAsync(file, args, { encoding: "utf8", windowsHide: true, ...rest });
  if (!timeout) return p;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; killTree(p.child.pid); }, timeout);
  return p.then(
    (r) => { clearTimeout(timer); return r; },
    (e: Error & { killed?: boolean }) => { clearTimeout(timer); if (timedOut) { e.killed = true; e.message = `timed out after ${timeout} ms: ${e.message}`; } throw e; },
  );
}

/**
 * A program on the PATH, found the way the shell would (Windows: with the PATHEXT extensions), or null. No `which`
 * or `where`: both differ between platforms and `which` does not exist on Windows.
 */
export function findOnPath(name: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  const win = platform === "win32";
  const dirs = (env.PATH ?? env.Path ?? "").split(win ? ";" : ":").filter(Boolean);
  const exts = win ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const d of dirs) for (const e of exts) {
    const p = join(d.replace(/^"|"$/g, ""), name + e);
    try { if (statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return null;
}

/** Spine's own folder (settings, backups, log): Esoteric's documented locations. */
export function spineUserDir(platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (platform === "win32") return win32.join(home, "Spine");
  if (platform === "linux") return posix.join(home, ".spine");
  return posix.join(home, "Library", "Application Support", "Spine");
}

/** Font files ImageMagick can draw labels with, in order of preference (macOS, Windows, Linux). */
export function fontCandidates(bold = false, env: NodeJS.ProcessEnv = process.env): string[] {
  // Forward slashes: ImageMagick reads backslashes in -font as escapes ("C:WindowsFontsarial.ttf") and quietly falls
  // back to its default font; Windows takes either separator.
  const winFonts = `${(env.WINDIR ?? env.windir ?? "C:\\Windows").replace(/\\/g, "/").replace(/\/$/, "")}/Fonts`;
  return [
    ...(bold ? ["/System/Library/Fonts/Supplemental/Arial Bold.ttf"] : []),
    "/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf",
    ...(bold ? [`${winFonts}/arialbd.ttf`] : []), `${winFonts}/arial.ttf`,
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ];
}

/** Where Unity Hub installs editors by default (UNITY_HUB_EDITORS overrides): one folder per version. */
export function unityHubEditors(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.UNITY_HUB_EDITORS) return env.UNITY_HUB_EDITORS;
  if (platform === "win32") return win32.join(env.ProgramFiles ?? "C:\\Program Files", "Unity", "Hub", "Editor");
  if (platform === "linux") return posix.join(home, "Unity", "Hub", "Editor");
  return "/Applications/Unity/Hub/Editor";
}

/** The Unity executable and its Resources folder inside one Hub editor folder. */
export function unityLayout(editorDir: string, platform: NodeJS.Platform = process.platform): { exe: string; resources: string } {
  if (platform === "darwin") return { exe: join(editorDir, "Unity.app", "Contents", "MacOS", "Unity"), resources: join(editorDir, "Unity.app", "Contents", "Resources") };
  return { exe: join(editorDir, "Editor", platform === "win32" ? "Unity.exe" : "Unity"), resources: join(editorDir, "Editor", "Data", "Resources") };
}

/**
 * Windows setup advice for spine_doctor. Not verified on a Windows machine with Spine and Unity (CI runs Windows
 * without them): whether Spine.com reads non-ASCII paths, and how deep Unity's caches nest under the work folder.
 */
export function windowsSetupWarnings(workDir: string, spineBin: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "win32") return [];
  const out: string[] = [];
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(workDir)) out.push(`The work folder ${workDir} has non-ASCII letters (a profile folder such as "Işık"). Spine's Java launcher may not read such paths on Windows (not verified): if exports or renders fail, set SPINE_MCP_WORKDIR to a plain folder such as C:\\spine-mcp. Projects in such folders may need moving too.`);
  if (workDir.length > 50) out.push(`The work folder path is ${workDir.length} characters: spine_unity_check keeps Unity projects and a spine-runtimes clone under it, which can pass Windows' 260-character path limit. A short SPINE_MCP_WORKDIR (C:\\spine-mcp) or Windows long paths (LongPathsEnabled) avoid it.`);
  if (/\.(cmd|bat)$/i.test(spineBin)) out.push(`SPINE_BIN points at a ${spineBin.slice(-4)} script: Node cannot start those without a shell. Point it at Spine.com.`);
  return out;
}
