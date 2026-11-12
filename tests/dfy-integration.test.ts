import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { SpineCli } from "../src/spine/cli.js";
import { loadProject, pickSkeleton } from "../src/spine/project.js";
import { addAnimation } from "../src/spine/write.js";
import { renderFrames } from "../src/spine/render.js";
import { sha256File } from "../src/spine/backup.js";

const source = join(process.cwd(), "DFY");
const enabled = process.env.SPINE_INTEGRATION === "1" && existsSync(join(source, "DFY.spine"));
describe.skipIf(!enabled)("DFY Spine 4.3 integration", () => {
  const root = mkdtempSync(join(tmpdir(), "spine-mcp-dfy-"));
  const projectDir = join(root, "DFY");
  const project = join(projectDir, "DFY.spine");
  const config = { ...loadConfig(), workDir: join(root, "work") };
  const cli = new SpineCli(config);
  it("exports the provided DFY project and reads its animations", async () => {
    cpSync(source, projectDir, { recursive: true });
    const loaded = await loadProject(config, cli, project);
    const skeleton = pickSkeleton(loaded, "DFY");
    expect(skeleton.doc.skeleton.spine).toMatch(/^4\.3\./);
    expect(Object.keys(skeleton.doc.animations ?? {})).toEqual(expect.arrayContaining(["idle", "think"]));
  }, 180_000);
  it("writes a new animation to a DFY copy and preserves the source", async () => {
    const before = sha256File(project);
    const sourceAnimation = pickSkeleton(await loadProject(config, cli, project), "DFY").doc.animations!.idle!;
    const animation = structuredClone(sourceAnimation);
    for (const key of animation.bones?.["头"]?.rotate ?? []) key.value = (key.value ?? 0) - 2;
    const result = await addAnimation(config, cli, { project, skeleton: "DFY", name: "test_dfy_nod", animation, apply: true, editor: "inPlace" });
    expect(result.mode).toBe("applied");
    expect(result.verification).toMatchObject({ animationMatches: true, otherAnimationsUnchanged: true, structureUnchanged: true, differences: [] });
    expect(sha256File(project)).not.toBe(before);
    const after = pickSkeleton(await loadProject(config, cli, project, { refresh: true }), "DFY").doc;
    expect(after.animations?.test_dfy_nod).toBeDefined();
  }, 180_000);
  it("renders a DFY animation through Spine CLI", async () => {
    const result = await renderFrames(config, cli, project, { skeleton: "DFY", animation: "idle", scale: 10, maxFrames: 4, cache: { imagesDir: join(projectDir, "images") } });
    expect(result.frames.length).toBeGreaterThan(1);
  }, 180_000);
});
