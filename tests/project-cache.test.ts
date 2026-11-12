import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { exportCacheDir, loadProject } from "../src/spine/project.js";
import type { SpineCli, CliResult } from "../src/spine/cli.js";

const dir = mkdtempSync(join(tmpdir(), "spine-cache-"));
const project = join(dir, "hero.spine");
writeFileSync(project, "test project");
const config = { ...loadConfig(), workDir: join(dir, "cache") };
const doc = { skeleton: { spine: "4.3.26" }, bones: [{ name: "root" }] };
const ok: CliResult = { command: [], exitCode: 0, seconds: 0, lines: [], warnings: [], errors: [], timedOut: false, raw: "" };
afterAll(() => rmSync(dir, { recursive: true, force: true }));
describe("project export cache", () => {
  it("isolates CLI versions and executable paths", () => {
    expect(exportCacheDir(config, project)).not.toBe(exportCacheDir({ ...config, spineVersion: "4.3.27" }, project));
    expect(exportCacheDir(config, project)).not.toBe(exportCacheDir({ ...config, spineBin: join(dir, "other") }, project));
  });
  it("coalesces cold concurrent loads, isolates documents and honors refresh", async () => {
    let calls = 0;
    const cli = { run: async (args: string[]) => {
      calls++;
      await new Promise(resolve => setTimeout(resolve, 10));
      const out = args[args.indexOf("-o") + 1]!;
      mkdirSync(out, { recursive: true }); writeFileSync(join(out, "hero.json"), JSON.stringify(doc));
      return ok;
    } } as SpineCli;
    const results = await Promise.all(Array.from({ length: 8 }, () => loadProject(config, cli, project)));
    expect(calls).toBe(1);
    results[0]!.skeletons[0]!.doc.bones[0]!.name = "modified";
    expect(results[1]!.skeletons[0]!.doc.bones[0]!.name).toBe("root");
    await loadProject(config, cli, project);
    expect(calls).toBe(1);
    await loadProject(config, cli, project, { refresh: true });
    expect(calls).toBe(2);
  });
});
