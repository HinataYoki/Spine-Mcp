import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import type { Config } from "../config.js";
import { budgetReport, type BudgetLimits } from "./budget.js";
import type { SpineCli } from "./cli.js";
import { loadProject } from "./project.js";
import { rigQa } from "./rigqa.js";
import { loadSkeletonData } from "./runtime.js";
import { issueCounts, validateSkeleton } from "./validate.js";

export interface AuditRow {
  file: string;
  skeleton: string;
  bones: number;
  animations: number;
  validate: { errors: number; warnings: number; firstErrors: string[] };
  rigQa: { warnings: number; infos: number; warningCodes: string[] };
  budget: { vertexTransforms: number; drawCalls: number; clippedTriangles: number; overBudget: string[] };
  ok: boolean;
}

export interface AuditResult {
  folder: string;
  files: number;
  skeletons: number;
  failed: number;
  /** The walk stopped at max files or 12 folders deep: not everything was audited. */
  truncated: boolean;
  rows: AuditRow[];
  errors: { file: string; error: string }[];
  ok: boolean;
  seconds: number;
  notes: string[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", "Library", "Temp", "obj", "build", "dist"]);

/** .spine projects, plus skeleton .json files that are not an export sitting next to their own .spine. */
export function findSkeletonFiles(folder: string, max = 200): { files: string[]; truncated: boolean } {
  const out: string[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    if (out.length >= max) { truncated = true; return; }
    if (depth > 12) { truncated = true; return; }
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, depth + 1); continue; }
      const ext = extname(e.name).toLowerCase();
      if (ext === ".spine" && !e.name.endsWith("-mcp-staging.spine")) out.push(p);
      else if (ext === ".json" && !hasProjectNearby(dir, folder) && isSkeletonJson(p)) out.push(p);
      if (out.length >= max) { truncated = true; return; }
    }
  };
  walk(folder, 0);
  return { files: out, truncated };
}

/** Exports usually sit next to their project or in a subfolder of it: skip JSON there (the project is audited). */
function hasProjectNearby(dir: string, root: string): boolean {
  // The parent counts only inside the audited folder (auditing an export folder on its own must find its JSON).
  return (dir === root ? [dir] : [dir, dirname(dir)]).some((d) => {
    try {
      return readdirSync(d).some((f) => f.toLowerCase().endsWith(".spine"));
    } catch {
      return false;
    }
  });
}

function isSkeletonJson(path: string): boolean {
  try {
    if (statSync(path).size > 50_000_000) return false;
    const head = readFileSync(path, "utf8").slice(0, 400);
    return /"skeleton"\s*:/.test(head) && /"spine"\s*:/.test(head);
  } catch {
    return false;
  }
}

/** Validate + rig QA + budget for every skeleton under a folder; ok = no validation errors, no rig QA warnings, nothing over `limits`. */
export async function auditFolder(config: Config, cli: SpineCli, folder: string, o: { limits?: BudgetLimits; strict?: boolean; max?: number } = {}): Promise<AuditResult> {
  const t0 = Date.now();
  const { files, truncated } = findSkeletonFiles(folder, o.max ?? 200);
  const rows: AuditRow[] = [], errors: { file: string; error: string }[] = [];
  for (const file of files) {
    try {
      const loaded = await loadProject(config, cli, file);
      for (const s of loaded.skeletons) {
        const version = String(s.doc.skeleton?.spine ?? "");
        if (!version.startsWith("4.3")) { errors.push({ file: relative(folder, file) || basename(file), error: `Spine ${version || "unknown"} data; spine-mcp reads 4.3 (re-export from Spine 4.3)` }); continue; }
        const issues = validateSkeleton(s.doc);
        const counts = issueCounts(issues);
        const qa = rigQa(s.doc, { baseDir: dirname(file), otherSkeletons: loaded.skeletons.filter((k) => k !== s).map((k) => k.doc) });
        const b = budgetReport(loadSkeletonData(s.doc), s.doc.animations ?? {}, { pagesKnown: false, limits: o.limits, fps: 15 });
        const qaWarnings = qa.findings.filter((f) => f.severity === "warning").map((f) => f.code);
        const ok = counts.errors === 0 && qaWarnings.length === 0 && b.overBudget.length === 0 && (!o.strict || counts.warnings === 0);
        rows.push({
          file: relative(folder, file) || basename(file), skeleton: s.name, bones: s.doc.bones.length, animations: Object.keys(s.doc.animations ?? {}).length,
          validate: { errors: counts.errors, warnings: counts.warnings, firstErrors: issues.filter((i) => i.severity === "error").slice(0, 3).map((i) => i.message) },
          rigQa: { warnings: qa.summary.warnings, infos: qa.summary.infos, warningCodes: qaWarnings },
          budget: { vertexTransforms: b.worst.vertexTransforms, drawCalls: b.worst.drawCalls, clippedTriangles: b.worst.clippedTriangles, overBudget: b.overBudget },
          ok,
        });
      }
    } catch (e) {
      errors.push({ file: relative(folder, file) || basename(file), error: (e as Error).message.slice(0, 300) });
    }
  }
  const failed = rows.filter((r) => !r.ok).length;
  if (!files.length) errors.push({ file: ".", error: "No Spine projects or skeleton JSON found: nothing was audited." });
  return {
    folder, files: files.length, skeletons: rows.length, failed, truncated, rows, errors, ok: failed === 0 && errors.length === 0 && !truncated,
    seconds: +((Date.now() - t0) / 1000).toFixed(1),
    notes: [
      `ok = no validation errors, no rig QA warnings${o.strict ? ", no validation warnings" : ""}${o.limits ? ", nothing over limits" : ""}. Budget sampled at 15 fps without an atlas (draw calls = blend mode switches); run spine_budget with pack: true for exact numbers.`,
      "Details per skeleton: spine_validate, spine_rig_qa, spine_budget. In CI: node scripts/audit.mjs <folder> exits 1 when not ok.",
    ],
  };
}
