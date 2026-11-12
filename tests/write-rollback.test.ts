import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { listBackups, sha256File } from "../src/spine/backup.js";
import { loadConfig } from "../src/config.js";
import type { CliResult, SpineCli } from "../src/spine/cli.js";
import { setEditorProbe } from "../src/spine/editor.js";
import { addAnimation } from "../src/spine/write.js";
import { FIXTURES, loadMini } from "./helpers.js";

/** Fake CLI: exports always return the fixture; imports touch the project and return the given warnings. */
function fakeCli(importWarnings: string[]): SpineCli {
  const result = (over: Partial<CliResult>): CliResult => ({
    command: [], exitCode: 0, seconds: 0, lines: [], warnings: [], errors: [], timedOut: false, raw: "", ...over,
  });
  return {
    available: true,
    run: async (args: string[]) => {
      const out = args[args.indexOf("-o") + 1]!;
      if (!args.includes("-o")) return { command: [], exitCode: 0, seconds: 0, lines: [], warnings: [], errors: [], timedOut: false, raw: "" }; // project info: nothing to report
      if (args.includes("-e")) {
        mkdirSync(out, { recursive: true });
        copyFileSync(join(FIXTURES, "mini.json"), join(out, "mini.json"));
        return result({});
      }
      appendFileSync(out, "corrupted by import");
      return result({ warnings: importWarnings });
    },
  } as unknown as SpineCli;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "spine-mcp-rollback-"));
  const project = join(root, "mini.spine");
  writeFileSync(project, "original project bytes");
  return { config: { ...loadConfig(), workDir: join(root, "work") }, project, sha: sha256File(project) };
}

const anim = () => structuredClone(loadMini().animations!.idle!);

// No Spine editor running: these tests are about the write path, not the editor guard (an unreadable process list,
// as in a sandbox, would send writes to the staging copy).
beforeAll(() => setEditorProbe({ processes: () => [] }));

describe("addAnimation rollback", () => {
  it("restores the project when Spine prints a warning during import", async () => {
    const { config, project, sha } = setup();
    const cli = fakeCli(["Bone not found: [bone: x, animation: new-idle, skeleton: in]"]);
    await expect(addAnimation(config, cli, { project, name: "new-idle", animation: anim(), apply: true })).rejects.toThrow(/restored from backup/);
    expect(sha256File(project)).toBe(sha);
    expect(listBackups(config, project)).toHaveLength(1);
  });

  it("restores the project when the re-export does not contain the new animation", async () => {
    const { config, project, sha } = setup();
    await expect(addAnimation(config, fakeCli([]), { project, name: "new-idle", animation: anim(), apply: true })).rejects.toThrow(/Verification failed.*restored/);
    expect(sha256File(project)).toBe(sha);
  });

  it("does nothing in dry-run mode", async () => {
    const { config, project, sha } = setup();
    const r = await addAnimation(config, fakeCli([]), { project, name: "new-idle", animation: anim() });
    expect(r.mode).toBe("dry-run");
    expect(r.backup).toBeUndefined();
    expect(sha256File(project)).toBe(sha);
    expect(listBackups(config, project)).toHaveLength(0);
  });

  it("rejects bad input early", async () => {
    const { config, project } = setup();
    await expect(addAnimation(config, fakeCli([]), { project, name: " ", animation: anim() })).rejects.toThrow(/empty/);
    await expect(addAnimation(config, fakeCli([]), { project, name: "idle", animation: anim() })).rejects.toThrow(/already exists/);
    await expect(addAnimation(config, fakeCli([]), { project, name: "x", animation: [] as never })).rejects.toThrow(/animation object/);
  });
});

describe("addAnimation concurrency and unexpected errors (review #4, #10)", () => {
  it("serializes parallel writes to the same project instead of failing both", async () => {
    const { config, project } = setup();
    let exports = 0;
    const added: string[] = [];
    const cli = {
      available: true,
      run: async (args: string[]) => {
        const out = args[args.indexOf("-o") + 1]!;
        const base = { command: [], exitCode: 0, seconds: 0, lines: [], warnings: [], errors: [], timedOut: false, raw: "" };
        if (!args.includes("-o")) return base; // project info (editor version query): nothing to report
        if (args.includes("-e")) {
          exports++;
          mkdirSync(out, { recursive: true });
          const doc = loadMini();
          for (const n of added) doc.animations![n] = structuredClone(doc.animations!.idle!);
          writeFileSync(join(out, "mini.json"), JSON.stringify(doc));
          return base;
        }
        added.push(args[args.indexOf("-a") + 1]!);
        appendFileSync(out, "+"); // project changes on disk after each import
        return base;
      },
    } as unknown as SpineCli;
    const results = await Promise.allSettled([
      addAnimation(config, cli, { project, name: "a1", animation: anim(), apply: true }),
      addAnimation(config, cli, { project, name: "b1", animation: anim(), apply: true }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(added).toEqual(["a1", "b1"]);
    expect(exports).toBe(3); // the second write reuses the first write's post-import export (same project state)
  });

  it("restores the project when verification itself throws", async () => {
    const { config, project, sha } = setup();
    let imported = false;
    const cli = {
      available: true,
      run: async (args: string[]) => {
        const out = args[args.indexOf("-o") + 1]!;
        if (!args.includes("-o")) return { command: [], exitCode: 0, seconds: 0, lines: [], warnings: [], errors: [], timedOut: false, raw: "" }; // project info: nothing to report
        const base = { command: [], exitCode: 0, seconds: 0, lines: [], warnings: [], errors: [], timedOut: false, raw: "" };
        if (args.includes("-e")) {
          mkdirSync(out, { recursive: true });
          // After the import, return JSON that spine-core cannot load (bone with a missing parent).
          const doc = loadMini();
          if (imported) doc.bones.push({ name: "broken", parent: "nope" });
          writeFileSync(join(out, "mini.json"), JSON.stringify(doc));
          return base;
        }
        imported = true;
        appendFileSync(out, "changed");
        return base;
      },
    } as unknown as SpineCli;
    await expect(addAnimation(config, cli, { project, name: "new-idle", animation: anim(), apply: true })).rejects.toThrow(/restored from backup/);
    expect(sha256File(project)).toBe(sha);
  });
});

describe("a rollback that fails", () => {
  it("is reported once, not retried as an unexpected error", async () => {
    const { config, project } = setup();
    let imported = false;
    const base = { command: [], exitCode: 0, seconds: 0, lines: [], warnings: [], errors: [], timedOut: false, raw: "" };
    const cli = {
      available: true,
      run: async (args: string[]) => {
        const out = args[args.indexOf("-o") + 1]!;
        if (!args.includes("-o")) return base;
        if (args.includes("-e")) {
          mkdirSync(out, { recursive: true });
          const doc = loadMini();
          if (imported) doc.bones.push({ name: "broken", parent: "nope" });
          writeFileSync(join(out, "mini.json"), JSON.stringify(doc));
          return base;
        }
        // The import breaks the project and the backup disappears with it: the restore has nothing to copy.
        imported = true;
        appendFileSync(out, "changed");
        rmSync(join(config.workDir, "backups"), { recursive: true, force: true });
        return base;
      },
    } as unknown as SpineCli;
    const err = await addAnimation(config, cli, { project, name: "new-idle", animation: anim(), apply: true }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/Rolling back FAILED/);
    expect(err!.message.match(/Rolling back FAILED/g)).toHaveLength(1);
    expect(err!.message).not.toMatch(/restored from backup/);
  });
});

describe("addAnimation issue filtering (review #5)", () => {
  it("does not attribute another animation's issues to a name that is its prefix", async () => {
    const { config, project } = setup();
    const r = await addAnimation(config, fakeCli([]), { project, name: "bad", animation: anim(), loopAnimations: ["bad", "bad-loop"] });
    expect(r.issues.filter((i) => i.where?.includes("bad-loop"))).toEqual([]);
  });

  it("still runs runtime checks for the new animation when the project has unrelated errors", async () => {
    const { config, project } = setup();
    const doc = loadMini();
    doc.slots![0]!.attachment = "missing-setup-attachment";
    const dir = join(project, "..", "fixture-with-error");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mini.json"), JSON.stringify(doc));
    const cli = {
      available: true,
      run: async (args: string[]) => {
        const out = args[args.indexOf("-o") + 1]!;
        if (!args.includes("-o")) return { command: [], exitCode: 0, seconds: 0, lines: [], warnings: [], errors: [], timedOut: false, raw: "" }; // project info: nothing to report
        mkdirSync(out, { recursive: true });
        copyFileSync(join(dir, "mini.json"), join(out, "mini.json"));
        return { command: [], exitCode: 0, seconds: 0, lines: [], warnings: [], errors: [], timedOut: false, raw: "" };
      },
    } as unknown as SpineCli;
    const pop = { bones: { head: { rotate: [{}, { time: 1, value: 40 }] } } };
    const r = await addAnimation(config, cli, { project, name: "pop-loop", animation: pop, loopAnimations: ["pop-loop"] });
    expect(r.preexistingErrors).toBe(1);
    expect(r.issues.map((i) => i.code)).toContain("loop-seam");
  });
});
