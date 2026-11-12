import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBackup, sha256File } from "../src/spine/backup.js";
import { loadConfig, type Config } from "../src/config.js";
import type { CliResult, SpineCli } from "../src/spine/cli.js";
import { setEditorProbe } from "../src/spine/editor.js";
import { exportCacheDir } from "../src/spine/project.js";
import { renderFrames } from "../src/spine/render.js";
import { readTrajectory, recordStep, trajectoryFile } from "../src/spine/trajectory.js";
import { addAnimation } from "../src/spine/write.js";
import { registerEditorTools } from "../src/tools/editor-tools.js";
import { loadMini } from "./helpers.js";

const ok = (over: Partial<CliResult> = {}): CliResult => ({ command: [], exitCode: 0, seconds: 1, lines: [], warnings: [], errors: [], timedOut: false, raw: "", ...over });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "spine-mcp-status-"));
  const project = join(root, "mini.spine");
  writeFileSync(project, "original project bytes");
  mkdirSync(join(root, "images"));
  writeFileSync(join(root, "images", "head.png"), "png bytes");
  const config: Config = { ...loadConfig(), workDir: join(root, "work") };
  return { root, project, config, images: join(root, "images") };
}

/** Exports return the fixture plus every animation imported so far; imports change the project bytes. */
function writingCli(warnOn?: string): SpineCli & { calls: string[][] } {
  const added: string[] = [];
  const calls: string[][] = [];
  return {
    available: true, calls,
    run: async (args: string[]) => {
      calls.push(args);
      const out = args[args.indexOf("-o") + 1]!;
      if (!args.includes("-o")) return ok();
      if (args.includes("-e")) {
        mkdirSync(out, { recursive: true });
        const doc = loadMini();
        for (const n of added) doc.animations![n] = structuredClone(doc.animations!.idle!);
        writeFileSync(join(out, "mini.json"), JSON.stringify(doc));
        return ok();
      }
      const name = args[args.indexOf("-a") + 1]!;
      appendFileSync(out, `+${name}`);
      if (name === warnOn) return ok({ warnings: ["Bone not found: [bone: x]"] });
      added.push(name);
      return ok();
    },
  } as unknown as SpineCli & { calls: string[][] };
}

/** Image export writes `frames` PNG files at the -o prefix and counts calls. */
function renderingCli(frames = 3): SpineCli & { renders: number } {
  const cli = {
    available: true, renders: 0,
    run: async (args: string[]) => {
      cli.renders++;
      const prefix = args[args.indexOf("-o") + 1]!;
      for (let i = 0; i < frames; i++) writeFileSync(`${prefix}_${String(i).padStart(2, "0")}.png`, `frame ${i}`);
      return ok();
    },
  };
  return cli as unknown as SpineCli & { renders: number };
}

const anim = () => structuredClone(loadMini().animations!.idle!);

beforeAll(() => setEditorProbe({ processes: () => [] }));
afterAll(() => setEditorProbe({ processes: () => [] }));

describe("trajectory log", () => {
  it("logs an applied write with tool, detail, summary, backup and the file's new sha", async () => {
    const { project, config } = setup();
    const r = await addAnimation(config, writingCli(), { project, name: "idle-v2", animation: anim(), apply: true, trace: { tool: "spine_generate_animation", detail: "breathe" } });
    expect(r.mode).toBe("applied");
    const steps = readTrajectory(config, project);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ tool: "spine_generate_animation", detail: "breathe", outcome: "applied", animation: "idle-v2", skeleton: "mini", backupId: r.backup!.id, sha256: sha256File(project) });
    expect(steps[0]!.duration).toBe(r.summary.duration);
  });

  it("does not log dry-runs", async () => {
    const { project, config } = setup();
    await addAnimation(config, writingCli(), { project, name: "idle-v2", animation: anim() });
    expect(readTrajectory(config, project)).toEqual([]);
  });

  it("logs a rolled-back write and still throws; the logged sha is the restored file", async () => {
    const { project, config } = setup();
    const sha = sha256File(project);
    await expect(addAnimation(config, writingCli("bad"), { project, name: "bad", animation: anim(), apply: true })).rejects.toThrow(/restored from backup/);
    const [step] = readTrajectory(config, project);
    expect(step).toMatchObject({ outcome: "rolledBack", tool: "spine_add_animation", animation: "bad", sha256: sha });
    expect(step!.error).toMatch(/Bone not found/);
  });

  it("a log that cannot be written never fails the write", async () => {
    const { project, config } = setup();
    // A file where the trajectory folder should be: every append fails.
    mkdirSync(config.workDir, { recursive: true });
    writeFileSync(join(config.workDir, "trajectory"), "not a folder");
    const r = await addAnimation(config, writingCli(), { project, name: "idle-v2", animation: anim(), apply: true });
    expect(r.mode).toBe("applied");
    expect(readTrajectory(config, project)).toEqual([]);
  });

  it("keeps the newest steps only and skips unreadable lines", () => {
    const { project, config } = setup();
    for (let i = 0; i < 400; i++) recordStep(config, project, { tool: "t", outcome: "snapshot", detail: String(i) });
    appendFileSync(trajectoryFile(config, project), "{broken\n");
    const steps = readTrajectory(config, project);
    expect(steps.length).toBeLessThanOrEqual(360);
    expect(steps.at(-1)!.detail).toBe("399");
  });
});

describe("render cache", () => {
  const opts = (config: Config, images: string | null, over: object = {}) => ({ skeleton: "mini", animation: "idle", fps: 10, cache: { imagesDir: images }, ...over });

  it("reuses an identical render without a CLI call", async () => {
    const { project, config, images } = setup();
    const cli = renderingCli();
    const a = await renderFrames(config, cli, project, opts(config, images));
    const b = await renderFrames(config, cli, project, opts(config, images));
    expect(cli.renders).toBe(1);
    expect(a.cached).toBe(false);
    expect(b).toMatchObject({ cached: true, dir: a.dir, frames: a.frames });
    expect(b.cli.seconds).toBe(0);
  });

  it("renders again when the project, an image, the settings or refresh change", async () => {
    const { project, config, images } = setup();
    const cli = renderingCli();
    await renderFrames(config, cli, project, opts(config, images));
    await renderFrames(config, cli, project, opts(config, images, { fps: 20 }));
    expect(cli.renders).toBe(2);
    appendFileSync(project, "saved");
    await renderFrames(config, cli, project, opts(config, images));
    expect(cli.renders).toBe(3);
    // Same size, new mtime: an image replaced in place.
    const later = new Date(Date.now() + 5_000);
    writeFileSync(join(images, "head.png"), "PNG BYTES");
    utimesSync(join(images, "head.png"), later, later);
    await renderFrames(config, cli, project, opts(config, images));
    expect(cli.renders).toBe(4);
    mkdirSync(join(images, "sub"));
    writeFileSync(join(images, "sub", "arm.png"), "x");
    await renderFrames(config, cli, project, opts(config, images));
    expect(cli.renders).toBe(5);
    await renderFrames(config, cli, project, { ...opts(config, images), cache: { imagesDir: images, refresh: true } });
    expect(cli.renders).toBe(6);
    await renderFrames(config, cli, project, opts(config, images));
    expect(cli.renders).toBe(6);
  });

  it("two identical renders in parallel keep one entry and both get complete frames", async () => {
    const { project, config, images } = setup();
    const cli = renderingCli();
    const [a, b] = await Promise.all([renderFrames(config, cli, project, opts(config, images)), renderFrames(config, cli, project, opts(config, images))]);
    expect(a.dir).toBe(b.dir);
    expect(a.frames).toEqual(b.frames);
    expect(a.frames.every(existsSync)).toBe(true);
    expect(readdirSync(join(config.workDir, "renders"))).toHaveLength(1);
  });

  it("never caches without an images folder or when not asked", async () => {
    const { project, config } = setup();
    const cli = renderingCli();
    await renderFrames(config, cli, project, opts(config, null));
    await renderFrames(config, cli, project, opts(config, null));
    await renderFrames(config, cli, project, { skeleton: "mini", animation: "idle" });
    await renderFrames(config, cli, project, { skeleton: "mini", animation: "idle" });
    expect(cli.renders).toBe(4);
  });

  it("treats a damaged entry (frames missing) and a failed render as misses", async () => {
    const { project, config, images } = setup();
    const cli = renderingCli();
    const a = await renderFrames(config, cli, project, opts(config, images));
    rmSync(a.frames[1]!);
    const b = await renderFrames(config, cli, project, opts(config, images));
    expect(cli.renders).toBe(2);
    expect(b.cached).toBe(false);
    expect(b.frames).toHaveLength(3);

    const failing = { available: true, run: async () => ok({ exitCode: 1, errors: ["ERROR: boom"] }) } as unknown as SpineCli;
    await expect(renderFrames(config, failing, project, opts(config, images, { fps: 12 }))).rejects.toThrow(/render failed/);
    const leftovers = readdirSync(join(config.workDir, "renders")).filter((d) => d.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("spine_status", () => {
  async function client(config: Config) {
    const cli = { available: true, run: async () => { throw new Error("spine_status must not call the Spine CLI"); } } as unknown as SpineCli;
    const server = new McpServer({ name: "t", version: "0" });
    registerEditorTools(server, config, cli);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "0" });
    await Promise.all([server.connect(a), c.connect(b)]);
    return async (args: object) => {
      const r = await c.callTool({ name: "spine_status", arguments: args });
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
      return JSON.parse((r.content as { text: string }[])[0]!.text);
    };
  }

  it("reports recent steps and notices a change made outside spine-mcp, without a CLI call", async () => {
    const { project, config } = setup();
    await addAnimation(config, writingCli(), { project, name: "idle-v2", animation: anim(), apply: true, trace: { tool: "spine_derive_animation", detail: "ease from idle" } });
    createBackup(config, project, "snapshot: x");
    recordStep(config, project, { tool: "spine_snapshot", outcome: "snapshot", detail: "x" });
    const status = await client(config);

    const s1 = await status({ project });
    expect(s1.trajectory.steps).toBe(2);
    expect(s1.trajectory.changedSinceLastStep).toBe(false);
    expect(s1.trajectory.recent[0]).toMatchObject({ tool: "spine_snapshot" });
    expect(s1.trajectory.recent[1]).toMatchObject({ tool: "spine_derive_animation", detail: "ease from idle", outcome: "applied" });
    expect(s1.trajectory.recent[1].sha256).toHaveLength(12);
    expect(s1.backups.count).toBe(2);
    // The post-write export is cached, so structure comes for free.
    expect(s1.skeletons[0].animations).toContain("idle-v2");
    expect(s1.editor.running).toBe(false);

    appendFileSync(project, "saved in the editor");
    const s2 = await status({ project, recent: 1 });
    expect(s2.trajectory.changedSinceLastStep).toBe(true);
    expect(s2.trajectory.recent).toHaveLength(1);
    expect(s2.skeletons).toBeUndefined();
    expect(s2.notes.join(" ")).toMatch(/changed since spine-mcp's last step/);
    expect(existsSync(exportCacheDir(config, project))).toBe(false);
  });

  it("works for a project spine-mcp never touched", async () => {
    const { project, config } = setup();
    const s = await (await client(config))({ project });
    expect(s.trajectory).toMatchObject({ steps: 0, recent: [] });
    expect(s.trajectory.changedSinceLastStep).toBeUndefined();
    expect(s.backups.count).toBe(0);
    expect(s.notes.join(" ")).toMatch(/no logged steps/);
  });
});

