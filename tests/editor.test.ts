import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { editorStatus, importSteps, isEditorProcess, setEditorProbe, stagingPathFor, stagingStale, useStaging } from "../src/spine/editor.js";

const BIN = "/Applications/Spine.app/Contents/MacOS/Spine";

describe("editor detection", () => {
  afterEach(() => setEditorProbe({ processes: () => [], settingsDir: "" }));

  it("tells editor windows from CLI runs", () => {
    expect(isEditorProcess({ pid: 1, args: BIN }, BIN, "darwin")).toBe(true);
    expect(isEditorProcess({ pid: 1, args: `${BIN} -u 4.3.26` }, BIN, "darwin")).toBe(true);
    expect(isEditorProcess({ pid: 1, args: `${BIN} /p/hero.spine` }, BIN, "darwin")).toBe(true);
    expect(isEditorProcess({ pid: 1, args: `${BIN} -u 4.3.26 -i /p/hero.spine -o /out -e json` }, BIN, "darwin")).toBe(false);
    expect(isEditorProcess({ pid: 1, args: `${BIN} --version` }, BIN, "darwin")).toBe(false);
    expect(isEditorProcess({ pid: 1, args: "/Volumes/x/Spine.app/Contents/MacOS/Spine" }, BIN, "darwin")).toBe(true);
    expect(isEditorProcess({ pid: 1, args: "/Applications/Spine.app/Contents/MacOS/SpineHelper" }, BIN, "darwin")).toBe(false);
    expect(isEditorProcess({ pid: 1, args: "node /src/spine-mcp/dist/index.js" }, BIN, "darwin")).toBe(false);
  });

  it("uses the recent-files list only as a hint while the editor runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-editor-"));
    writeFileSync(join(dir, "recent-1.json"), '{class:x,recentDirs:{dirs:{paths:[{path:"/p/"}]}},recentFiles:{projectFile:{max:100,paths:[{path:"/p/hero.spine",time:2},{path:"/p/old.spine",time:1}]}}}');
    setEditorProbe({ processes: () => [{ pid: 7, args: BIN }, { pid: 8, args: `${BIN} -i /p/x.spine -e json` }], settingsDir: dir });
    expect(editorStatus(BIN, "/p/hero.spine")).toMatchObject({ running: true, pids: [7], lastOpenedProject: "/p/hero.spine", projectOpen: "likely" });
    expect(editorStatus(BIN, "/p/old.spine").projectOpen).toBe("possible");
    setEditorProbe({ processes: () => [{ pid: 8, args: `${BIN} -i /p/x.spine -e json` }] });
    const off = editorStatus(BIN, "/p/hero.spine");
    expect(off).toMatchObject({ running: false, projectOpen: "no" });
    expect(off.lastOpenedProject).toBeUndefined();
  });

  it("picks staging only when asked or while the editor runs", () => {
    const on = { running: true, pids: [1] }, off = { running: false, pids: [] };
    expect(useStaging(undefined, on)).toBe(true);
    expect(useStaging("auto", off)).toBe(false);
    expect(useStaging("inPlace", on)).toBe(false);
    expect(useStaging("staging", off)).toBe(true);
  });
});

describe("staging copy", () => {
  it("is stale when missing or older than the project", () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-staging-"));
    const project = join(dir, "hero.spine");
    writeFileSync(project, "v1");
    const staging = stagingPathFor(project);
    expect(staging).toBe(join(dir, "hero-mcp-staging.spine"));
    expect(stagingStale(project, staging)).toBe(true);
    writeFileSync(staging, "v1 + new animation");
    utimesSync(project, new Date(1000), new Date(1000));
    expect(stagingStale(project, staging)).toBe(false);
    // The user saved in the editor after the copy was made.
    utimesSync(staging, new Date(500), new Date(500));
    expect(stagingStale(project, staging)).toBe(true);
  });

  it("names the file and animations in the import steps", () => {
    const steps = importSteps("/p/hero-mcp-staging.spine", [{ skeleton: "hero", animations: ["wave", "nod"] }, { skeleton: "pet", animations: ["sit"] }]).join("\n");
    expect(steps).toContain("Import Project");
    expect(steps).toContain("/p/hero-mcp-staging.spine");
    expect(steps).toContain('Skeleton "hero" (source and target): tick wave, nod');
    expect(steps).toContain('Skeleton "pet" (source and target): tick sit');
  });
});

describe("older projects", () => {
  it("refuses a write that would save an older major.minor project in the pinned format", async () => {
    const { addAnimation } = await import("../src/spine/write.js");
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-old-"));
    const project = join(dir, "old.spine");
    writeFileSync(project, "binary");
    const cli = { run: async () => ({ lines: [`Project info: ${project}`, "Spine version: 4.2.43"], warnings: [], errors: [], exitCode: 0 }) };
    const config = { spineBin: "/nope/Spine", spineVersion: "4.3.26", workDir: join(dir, "work"), cliTimeoutMs: 1000 };
    await expect(addAnimation(config, cli as never, { project, name: "x", animation: {}, apply: true, editor: "inPlace" })).rejects.toThrow(/saved with Spine 4\.2\.43.*cannot open.*allowUpgrade/);
  });
});
