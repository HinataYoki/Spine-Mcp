import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test's mkdtempSync(tmpdir()) lands in one folder per run, removed afterwards (KEEP_TEST_TMP=1 keeps it).
export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), "spine-mcp-tests-"));
  // Trailing slash: Unity joins TMPDIR and file names without a separator.
  process.env.TMPDIR = `${dir}/`;
  // Windows: os.tmpdir() reads TEMP and TMP, not TMPDIR.
  if (process.platform === "win32") process.env.TEMP = process.env.TMP = dir;
  return () => {
    if (!process.env.KEEP_TEST_TMP) rmSync(dir, { recursive: true, force: true });
  };
}
