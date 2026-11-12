import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRuntimes, pinnedRuntime } from "../src/spine/unity.js";

const UNITY = "com.esotericsoftware.spine.spine-unity", CSHARP = "com.esotericsoftware.spine.spine-csharp";
const A = "44e0f10ea13b1448e1a6412902593fbd7a41841c", B = "112431f1246e0000000000000000000000000000";

function project(deps: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "spine-mcp-pin-"));
  mkdirSync(join(dir, "Packages"));
  writeFileSync(join(dir, "Packages", "packages-lock.json"), JSON.stringify({ dependencies: deps }));
  return dir;
}

describe("pinned spine-unity runtime", () => {
  it("takes a full commit as it is", () => {
    expect(pinnedRuntime(A.toUpperCase())).toEqual({ commit: A, from: "commit", csharpCommit: null });
  });

  it("reads the commit a Unity project's lock pins, with spine-csharp's", () => {
    const dir = project({ [UNITY]: { version: "https://github.com/EsotericSoftware/spine-runtimes.git?path=spine-unity/Assets/Spine#4.3", source: "git", hash: A }, [CSHARP]: { source: "git", hash: B } });
    const pin = pinnedRuntime(dir);
    expect(pin.commit).toBe(A);
    expect(pin.csharpCommit).toBe(B);
    expect(pin.from).toContain("packages-lock.json");
  });

  it("refuses short commits, relative paths, missing locks and packages not from git", () => {
    expect(() => pinnedRuntime("44e0f10")).toThrow(/absolute Unity project path/);
    expect(() => pinnedRuntime(mkdtempSync(join(tmpdir(), "spine-mcp-pin-")))).toThrow(/packages-lock/);
    expect(() => pinnedRuntime(project({}))).toThrow(/no com.esotericsoftware.spine.spine-unity/);
    expect(() => pinnedRuntime(project({ [UNITY]: { source: "embedded", version: "4.3.88" } }))).toThrow(/not a git commit/);
  });
});

describe("SPINE_UNITY_RUNTIMES and a pin", () => {
  const saved = process.env.SPINE_UNITY_RUNTIMES;
  afterEach(() => {
    if (saved === undefined) delete process.env.SPINE_UNITY_RUNTIMES;
    else process.env.SPINE_UNITY_RUNTIMES = saved;
  });

  function checkout(): { dir: string; head: string } {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-runtimes-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(dir, "a.txt"), "a");
    git("add", "a.txt");
    git("commit", "-q", "-m", "a");
    return { dir, head: git("rev-parse", "HEAD") };
  }

  function cached(root: string, commit: string): string {
    const dir = join(root, `spine-runtimes-${commit.slice(0, 12)}`);
    mkdirSync(join(dir, "spine-unity", "Assets", "Spine"), { recursive: true });
    writeFileSync(join(dir, "spine-unity", "Assets", "Spine", "package.json"), JSON.stringify({ version: "4.3.88" }));
    return dir;
  }

  it("is used without a pin, and for a pin only when it is checked out at that commit", async () => {
    const { dir, head } = checkout();
    process.env.SPINE_UNITY_RUNTIMES = dir;
    const root = mkdtempSync(join(tmpdir(), "spine-mcp-root-"));
    expect(await ensureRuntimes(root, "4.3")).toBe(dir);
    expect(await ensureRuntimes(root, "4.3", head.toUpperCase())).toBe(dir);
    const pinned = cached(root, A);
    expect(await ensureRuntimes(root, "4.3", A)).toBe(pinned);
  });
});
