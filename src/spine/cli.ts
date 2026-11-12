import { killTree, spawn } from "../platform.js";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";

export interface CliResult {
  command: string[];
  exitCode: number | null;
  seconds: number;
  /** Output without launcher banner lines. */
  lines: string[];
  /** Lines Spine prints for problems that do not fail the command (e.g. dropped timelines). */
  warnings: string[];
  /** `ERROR:` / `Cause:` lines. */
  errors: string[];
  timedOut: boolean;
  /** Unfiltered output, for callers that need banner lines (e.g. version, license). */
  raw: string;
}

const BANNER = ["Spine Launcher", "Esoteric Software", "Mac OS X", "Starting:", "Licensed to", "Spine 4.", "Complete."];

// Spine reports these with exit code 0 even though data was dropped or renamed (GOTCHAS G07, G08).
const WARNING_PATTERNS = [
  /^WARNING:/,
  /Bone not found/,
  /Slot not found/,
  /attachment not found/i,
  /already exists/,
  /not found:/,
];

export function parseCliOutput(raw: string): Pick<CliResult, "lines" | "warnings" | "errors"> {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0 && !BANNER.some((b) => l.startsWith(b)));
  const errors = lines.filter((l) => /^(ERROR:|Cause:|Error:)/.test(l.trim()));
  const warnings = lines.filter((l) => !errors.includes(l) && WARNING_PATTERNS.some((p) => p.test(l)));
  return { lines, warnings, errors };
}

/**
 * The folder the CLI runs in: an empty one in the work folder. Spine takes `-e json` / `-e binary` for an export
 * settings file when the working folder holds an entry by that name ("Error reading Spine export settings JSON
 * file", G115), and an MCP server runs wherever its client started it.
 */
export function cliWorkingDir(config: Config): string {
  const dir = join(config.workDir, "cli-cwd");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export class SpineCli {
  /** Spine launchers run one at a time: MCP clients may call tools in parallel. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: Config) {}

  get available(): boolean {
    return existsSync(this.config.spineBin);
  }

  /** Runs the Spine CLI. `pin` prepends `-u <version>` (skip it for `--version`/`--help`); `version` overrides the pinned one. */
  run(args: string[], options: { pin?: boolean; timeoutMs?: number; version?: string } = {}): Promise<CliResult> {
    const next = this.queue.then(() => this.spawn(args, options));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private spawn(args: string[], options: { pin?: boolean; timeoutMs?: number; version?: string }): Promise<CliResult> {
    const { pin = true, timeoutMs = this.config.cliTimeoutMs } = options;
    const version = options.version ?? this.config.spineVersion;
    const fullArgs = pin && version ? ["-u", version, ...args] : args;
    const command = [this.config.spineBin, ...fullArgs];
    if (!this.available) {
      return Promise.resolve({
        command, exitCode: null, seconds: 0, lines: [], warnings: [], timedOut: false, raw: "",
        errors: [`Spine binary not found: ${this.config.spineBin} (set SPINE_BIN)`],
      });
    }
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(this.config.spineBin, fullArgs, { stdio: ["ignore", "pipe", "pipe"], cwd: cliWorkingDir(this.config) });
      let out = "";
      let timedOut = false;
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => {
        timedOut = true;
        // The whole tree: on Windows, Spine.com's Java process would keep running and keep writing.
        killTree(child.pid, "SIGKILL");
      }, timeoutMs);
      const finish = (exitCode: number | null, extraError?: string) => {
        clearTimeout(timer);
        const parsed = parseCliOutput(out);
        if (extraError) parsed.errors.push(extraError);
        if (timedOut) parsed.errors.push(`Spine CLI timed out after ${timeoutMs} ms`);
        resolve({ command, exitCode, seconds: +((Date.now() - started) / 1000).toFixed(1), timedOut, raw: out, ...parsed });
      };
      child.on("error", (e) => finish(null, e.message));
      child.on("close", (code) => finish(code));
    });
  }
}

export function cliFailed(r: CliResult): boolean {
  return r.exitCode !== 0 || r.timedOut || r.errors.length > 0;
}
