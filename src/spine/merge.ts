// Merging the work of several animators who each changed a copy of the same project: per animation, which copy added
// or changed it, where two copies changed it differently (a conflict), and what in a copy's rig differs from the base.
import { compareAnimations, exportsEqual } from "./compare.js";
import { loadSkeletonData } from "./runtime.js";
import type { SkeletonJson } from "./types.js";

export interface MergeCopy {
  path: string;
  doc: SkeletonJson;
}

export interface MergeEntry {
  animation: string;
  /** add: new in a copy; change: a copy changed it; conflict: copies changed it differently; delete: a copy removed it (never applied). */
  action: "add" | "change" | "conflict" | "delete";
  /** The copy the animation is taken from (add / change, or the preferred one in a conflict). */
  from?: string;
  /** Copies involved (all that changed it, for conflicts; the ones that removed it, for delete). */
  copies: string[];
  /** For a change: how it differs from the base (first few differences). */
  differences?: string[];
}

export interface MergePlan {
  entries: MergeEntry[];
  /** Copies whose rig (bones, slots, skins, constraints, events) differs from the base: only animations merge. */
  rigChanges: { copy: string; parts: string[] }[];
  unchanged: number;
  notes: string[];
}

/**
 * Compares each copy with the base project, animation by animation (key data and, when that differs, the motion in
 * spine-core): what to bring into the base, and the conflicts. `prefer` picks the copy for a conflicting animation.
 */
export function mergePlan(base: SkeletonJson, copies: MergeCopy[], prefer: Record<string, string> = {}): MergePlan {
  const dataBase = loadSkeletonData(base);
  const datas = copies.map((c) => loadSkeletonData(c.doc));
  const names = new Set<string>(Object.keys(base.animations ?? {}));
  for (const c of copies) for (const n of Object.keys(c.doc.animations ?? {})) names.add(n);
  const entries: MergeEntry[] = [];
  let unchanged = 0;
  for (const name of [...names].sort()) {
    const inBase = base.animations?.[name];
    const changed: { copy: string; i: number; differences: string[] }[] = [];
    const removed: string[] = [];
    copies.forEach((c, i) => {
      const a = c.doc.animations?.[name];
      if (!a) { if (inBase) removed.push(c.path); return; }
      if (!inBase) { changed.push({ copy: c.path, i, differences: [] }); return; }
      if (JSON.stringify(a) === JSON.stringify(inBase)) return;
      const d = compareAnimations(dataBase.findAnimation(name)!, datas[i]!.findAnimation(name)!, { a: dataBase, b: datas[i]! });
      if (!d.equal) changed.push({ copy: c.path, i, differences: d.differences.slice(0, 4) });
    });
    if (!changed.length) {
      if (removed.length) entries.push({ animation: name, action: "delete", copies: removed });
      else unchanged++;
      continue;
    }
    // Copies that made the same change agree.
    const distinct = changed.filter((c, k) => !changed.slice(0, k).some((p) => {
      const a = copies[p.i]!.doc.animations![name]!, b = copies[c.i]!.doc.animations![name]!;
      return JSON.stringify(a) === JSON.stringify(b) || compareAnimations(datas[p.i]!.findAnimation(name)!, datas[c.i]!.findAnimation(name)!, { a: datas[p.i]!, b: datas[c.i]! }).equal;
    }));
    const action: MergeEntry["action"] = distinct.length > 1 ? "conflict" : inBase ? "change" : "add";
    const chosen = action === "conflict" ? (prefer[name] ? changed.find((c) => c.copy === prefer[name]) : undefined) : distinct[0];
    if (action === "conflict" && prefer[name] && !chosen) throw new Error(`prefer.${name}: ${prefer[name]} is not one of the copies that changed it (${changed.map((c) => c.copy).join(", ")})`);
    entries.push({ animation: name, action, ...(chosen ? { from: chosen.copy } : {}), copies: (action === "conflict" ? changed : distinct).map((c) => c.copy), ...(chosen?.differences.length ? { differences: chosen.differences } : {}) });
  }
  const rigChanges = copies.map((c) => ({ copy: c.path, parts: exportsEqual(base, c.doc, ["skeleton"]) })).filter((r) => r.parts.length);
  const notes: string[] = [];
  const conflicts = entries.filter((e) => e.action === "conflict" && !e.from);
  if (conflicts.length) notes.push(`${conflicts.length} animation(s) changed differently in several copies: ${conflicts.map((e) => e.animation).join(", ")}. Pick one with prefer: { animation: copy path }; they are left out until then.`);
  if (entries.some((e) => e.action === "delete")) notes.push("Animations a copy removed stay in the base (deleting is your call in the editor).");
  if (rigChanges.length) notes.push(`Rig changes in ${rigChanges.map((r) => `${r.copy} (${r.parts.join(", ")})`).join("; ")}: only animations merge (a rig change needs a full import that drops editor data); animations from those copies are matched to the base's bones and slots by name, and anything without a counterpart is reported.`);
  return { entries, rigChanges, unchanged, notes };
}
