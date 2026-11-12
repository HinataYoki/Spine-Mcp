import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { createBackup, listBackups } from "../spine/backup.js";
import type { SpineCli } from "../spine/cli.js";
import { assertInputPath, loadProject, pickSkeleton, UserError } from "../spine/project.js";
import { diffSkeletons } from "../spine/reimport.js";
import { recordStep } from "../spine/trajectory.js";
import { guarded, json } from "./util.js";

const SNAPSHOT = "snapshot";

export function registerReimportTools(server: McpServer, config: Config, cli: SpineCli) {
  server.registerTool("spine_snapshot", {
    title: "Snapshot a project",
    description: "Saves a labelled, verified backup copy before risky editor work (compare later with spine_reimport_diff). Without label: lists snapshots.",
    inputSchema: {
      project: z.string(),
      label: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, guarded(async ({ project, label }) => {
    assertInputPath(project, [".spine"]);
    if (!label) {
      return json({ snapshots: listBackups(config, project).filter((b) => b.reason.startsWith(SNAPSHOT)).map((b) => ({ id: b.id, label: b.reason.slice(SNAPSHOT.length + 2), createdAt: b.createdAt })) });
    }
    const entry = createBackup(config, project, `${SNAPSHOT}: ${label}`);
    recordStep(config, project, { tool: "spine_snapshot", outcome: "snapshot", detail: label, backupId: entry.id, sha256: entry.sha256 });
    const loaded = await loadProject(config, cli, project);
    return json({
      id: entry.id, label, sha256: entry.sha256,
      skeletons: loaded.skeletons.map((s) => ({ name: s.name, bones: s.doc.bones.length, animations: Object.keys(s.doc.animations ?? {}).length })),
      notes: ["After the re-import (save the project in Spine first), call spine_reimport_diff with this project."],
    });
  }));

  server.registerTool("spine_reimport_diff", {
    title: "What a re-import changed",
    description: [
      "Compares a project with a snapshot (default latest) or another .spine/.json: what broke (lost keys, weights, meshes, removed items) and what changed, then where playback of common animations now differs.",
    ].join(" "),
    inputSchema: {
      project: z.string(),
      snapshot: z.string().optional(),
      before: z.string().optional().describe("Or another .spine/.json"),
      skeleton: z.string().optional(),
      fps: z.number().int().min(5).max(120).optional(),
    },
    annotations: { readOnlyHint: true },
  }, guarded(async ({ project, snapshot, before, skeleton, fps }) => {
    assertInputPath(project, [".spine", ".json"]);
    let beforePath = before;
    let snapshotInfo: { id: string; label: string } | undefined;
    if (!beforePath) {
      const snaps = listBackups(config, project).filter((b) => b.reason.startsWith(SNAPSHOT));
      const entry = snapshot ? snaps.find((b) => b.id === snapshot) : snaps[0];
      if (!entry) throw new UserError(snapshot ? `Snapshot ${snapshot} not found (spine_snapshot lists them)` : "No snapshot for this project: take one with spine_snapshot before the re-import, or pass before");
      beforePath = entry.file;
      snapshotInfo = { id: entry.id, label: entry.reason.slice(SNAPSHOT.length + 2) };
    }
    const now = pickSkeleton(await loadProject(config, cli, project, { refresh: true }), skeleton);
    const old = await loadProject(config, cli, beforePath);
    const was = old.skeletons.find((s) => s.name === now.name) ?? (old.skeletons.length === 1 ? old.skeletons[0]! : undefined);
    if (!was) throw new UserError(`Skeleton "${now.name}" not found in the snapshot (has: ${old.skeletons.map((s) => s.name).join(", ")})`);
    const d = diffSkeletons(was.doc, now.doc, { fps });
    return json({
      skeleton: now.name, snapshot: snapshotInfo, verdict: d.broken.length ? `${d.broken.length} broken` : d.changed.length || d.animations.length ? "changed, nothing broken" : "identical",
      ...d, broken: d.broken.slice(0, 80), changed: d.changed.slice(0, 120), animations: d.animations.slice(0, 60),
      truncated: d.broken.length > 80 || d.changed.length > 120 || d.animations.length > 60 || undefined,
    });
  }));
}
