import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import type { SpineCli } from "../spine/cli.js";
import { compareAnimationAcrossDocs } from "../spine/compare.js";
import { EDITOR_OPEN_NOTE, EDITOR_UNKNOWN_NOTE, editorStatus, stagingPathFor } from "../spine/editor.js";
import { listBackups, sha256File } from "../spine/backup.js";
import { stagingSnapshot, stagingState } from "../spine/staging.js";
import { assertInputPath, exportCacheDir, loadProject, pickSkeleton, UserError } from "../spine/project.js";
import { readTrajectory } from "../spine/trajectory.js";
import type { SkeletonJson } from "../spine/types.js";
import { guarded, json } from "./util.js";

export function registerEditorTools(server: McpServer, config: Config, cli: SpineCli) {
  server.registerTool("spine_editor_status", {
    title: "Spine editor status and import check",
    description: [
      "Is a Spine editor window open (and likely on this project)? While it is, writes go to a verified staging copy. With project: what still waits in the staging copy; animations confirms each one after Import Project and a save.",
    ].join(" "),
    inputSchema: {
      project: z.string().optional(),
      staged: z.string().optional().describe("Staging copy"),
      animations: z.array(z.string()).optional(),
      skeleton: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ project, staged, animations, skeleton }) => {
    if (project) assertInputPath(project, [".spine"]);
    const status = editorStatus(config.spineBin, project);
    const notes = status.running ? [EDITOR_OPEN_NOTE] : status.unknown ? [EDITOR_UNKNOWN_NOTE] : ["No Spine editor window is open: write tools write the project directly (with backup and verification)."];
    if (!project) return json({ ...status, notes });
    const stagedPath = staged ?? stagingPathFor(project);
    if (!existsSync(stagedPath)) {
      if (animations?.length) throw new UserError(`Staging copy not found: ${stagedPath}`);
      return json({ ...status, notes });
    }
    assertInputPath(stagedPath, [".spine"]);
    const state = await stagingState(config, cli, project, stagedPath);
    if (state.pending.length) notes.push(`Still to import from ${stagedPath}: ${state.pending.map((g) => `${g.skeleton}: ${g.animations.join(", ")}`).join("; ")}.`);
    if (state.changed.length) notes.push(`Changed or removed in the project since spine-mcp wrote them (not offered any more): ${state.changed.join(", ")}.`);
    if (!animations?.length) {
      if (!state.pending.length) notes.push("Nothing waits in the staging copy: it can be deleted.");
      return json({ ...status, project, staged: stagedPath, ...state, notes });
    }
    const proj = pickSkeleton(await loadProject(config, cli, project, { refresh: true }), skeleton);
    const stage = pickSkeleton(await loadProject(config, cli, stagedPath, { refresh: true }), skeleton ?? proj.name);
    const checks = animations.map((name) => {
      if (!stage.doc.animations?.[name]) return { animation: name, ok: false, problem: "not in the staging copy" };
      if (!proj.doc.animations?.[name]) return { animation: name, ok: false, problem: "not in the project yet: import it and save in the editor first" };
      const d = compareAnimationAcrossDocs(stage.doc, proj.doc, name);
      return { animation: name, ok: d.equal, ...(d.equal ? {} : { differences: d.differences.slice(0, 8) }) };
    });
    const ok = checks.every((c) => c.ok);
    if (ok) notes.push(state.pending.length ? "The listed animations match their verified staging versions." : "Every animation matches its verified staging version and nothing else waits: the staging copy can be deleted.");
    return json({ ...status, project, staged: stagedPath, skeleton: proj.name, checks, ok, ...state, notes });
  }));

  server.registerTool("spine_status", {
    title: "Project status and recent spine-mcp steps",
    description: "Instant, no CLI: file state, editor window, staging copy, backups, spine-mcp's last steps on the project and outside changes since. Call first when resuming work.",
    inputSchema: {
      project: z.string(),
      recent: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ project, recent = 5 }) => {
    assertInputPath(project, [".spine"]);
    const st = statSync(project);
    const sha256 = sha256File(project);
    const steps = readTrajectory(config, project);
    const last = steps.findLast((s) => s.sha256);
    const changedSinceLastStep = last ? last.sha256 !== sha256 : undefined;
    const backups = listBackups(config, project);
    const editor = editorStatus(config.spineBin, project);
    // Structure only when an export of this exact file state is already cached (no CLI call here).
    const cacheDir = exportCacheDir(config, project);
    const skeletons = existsSync(cacheDir)
      ? readdirSync(cacheDir).filter((f) => f.endsWith(".json")).sort().map((f) => {
        const doc = JSON.parse(readFileSync(join(cacheDir, f), "utf8")) as SkeletonJson;
        return { name: f.slice(0, -5), bones: doc.bones.length, animations: Object.keys(doc.animations ?? {}) };
      })
      : undefined;
    const notes: string[] = [];
    if (!steps.length) notes.push("spine-mcp has no logged steps for this project yet.");
    else if (changedSinceLastStep) notes.push("The project file changed since spine-mcp's last step (saved in the editor or elsewhere): re-read it before building on earlier results.");
    if (!skeletons) notes.push("No export of this file state is cached yet; spine_inspect exports it (~3 s).");
    if (editor.running) notes.push(EDITOR_OPEN_NOTE);
    else if (editor.unknown) notes.push(EDITOR_UNKNOWN_NOTE);
    return json({
      project, sha256, size: st.size, modified: st.mtime.toISOString(),
      editor: { running: editor.running, ...(editor.unknown ? { unknown: true } : {}), projectOpen: editor.projectOpen },
      ...(skeletons ? { skeletons } : {}),
      staging: stagingSnapshot(config, project),
      backups: { count: backups.length, latest: backups[0] && { id: backups[0].id, reason: backups[0].reason, createdAt: backups[0].createdAt } },
      trajectory: {
        steps: steps.length, changedSinceLastStep,
        recent: steps.slice(-recent).reverse().map(({ sha256: sha, ...rest }) => ({ ...rest, ...(sha ? { sha256: sha.slice(0, 12) } : {}) })),
      },
      notes,
    });
  }));
}
