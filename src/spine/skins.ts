import { budgetReport, type BudgetLimits, type FrameMetrics } from "./budget.js";
import type { spine } from "./runtime.js";
import type { SkeletonJson } from "./types.js";

export interface SkinRow {
  skins: string[];
  attachments: number;
  /** Slot placeholders set by more than one skin of the combination; the last skin wins (Skin.addSkin). */
  conflicts: { slot: string; placeholder: string; skins: string[]; wins: string }[];
  /** Slots whose setup attachment no skin of the combination (or default) provides: they show nothing until keyed. */
  emptySetupSlots: string[];
  setup: Pick<FrameMetrics, "visibleAttachments" | "vertices" | "vertexTransforms" | "drawCalls">;
  worst: Pick<FrameMetrics, "visibleAttachments" | "vertices" | "vertexTransforms" | "drawCalls" | "area" | "clippedTriangles"> & { where: Partial<Record<keyof FrameMetrics, string>> };
  overBudget: string[];
}

export interface SkinReport {
  skins: string[];
  rows: SkinRow[];
  heaviest?: { skins: string[]; vertexTransforms: number; drawCalls: number };
  findings: string[];
  notes: string[];
}

const pick = <T extends object, K extends keyof T>(o: T, keys: K[]) => Object.fromEntries(keys.map((k) => [k, o[k]])) as Pick<T, K>;

/**
 * Skins one by one (default) or the combinations a mix-and-match runtime builds: attachments, placeholder conflicts,
 * slots left empty, and the budget (Spine Metrics, draw calls) of each, over the setup pose and every animation.
 */
export function skinReport(doc: SkeletonJson, data: spine.SkeletonData, o: { combinations?: string[][]; fps?: number; limits?: BudgetLimits; pagesKnown: boolean; animations?: boolean }): SkinReport {
  const all = (doc.skins ?? []).map((s) => s.name);
  const named = all.filter((n) => n !== "default").map((n) => [n]);
  const combos = o.combinations?.length ? o.combinations : named.length ? named : [["default"]];
  const byName = new Map((doc.skins ?? []).map((s) => [s.name, s]));
  const anims = o.animations === false ? {} : (doc.animations ?? {});
  const dataForBudget = o.animations === false ? withoutAnimations(data) : data;

  const rows = combos.map((names): SkinRow => {
    for (const n of names) if (!byName.has(n)) throw new Error(`Skin "${n}" not found. Skins: ${all.slice(0, 30).join(", ")}`);
    const owners = new Map<string, string[]>();
    let attachments = 0;
    for (const n of names) {
      for (const [slot, atts] of Object.entries(byName.get(n)!.attachments ?? {})) {
        for (const ph of Object.keys(atts)) {
          attachments++;
          const k = `${slot}\u0000${ph}`;
          (owners.get(k) ?? owners.set(k, []).get(k)!).push(n);
        }
      }
    }
    const conflicts = [...owners].filter(([, s]) => s.length > 1).map(([k, s]) => {
      const [slot, placeholder] = k.split("\u0000") as [string, string];
      return { slot, placeholder, skins: s, wins: s[s.length - 1]! };
    });
    const provided = (slot: string, ph: string) => owners.has(`${slot}\u0000${ph}`) || Boolean(byName.get("default")?.attachments?.[slot]?.[ph]);
    const emptySetupSlots = (doc.slots ?? []).filter((s) => s.attachment && !provided(s.name, s.attachment)).map((s) => s.name);
    const b = budgetReport(dataForBudget, anims, { fps: o.fps, limits: o.limits, pagesKnown: o.pagesKnown, skin: names });
    return {
      skins: names, attachments, conflicts: conflicts.slice(0, 20), emptySetupSlots: emptySetupSlots.slice(0, 20),
      setup: pick(b.setup, ["visibleAttachments", "vertices", "vertexTransforms", "drawCalls"]),
      worst: { ...pick(b.worst, ["visibleAttachments", "vertices", "vertexTransforms", "drawCalls", "area", "clippedTriangles"]), where: b.worst.where },
      overBudget: b.overBudget,
    };
  });

  const heaviest = [...rows].sort((a, b) => b.worst.vertexTransforms - a.worst.vertexTransforms)[0];
  const findings: string[] = [];
  const conflicted = rows.filter((r) => r.conflicts.length);
  if (conflicted.length) findings.push(`${conflicted.length} combination(s) set the same slot placeholder from several skins; the last skin listed wins (often intended, e.g. clothes over the base body: check the order). First: ${conflicted[0]!.skins.join(" + ")} on ${conflicted[0]!.conflicts.slice(0, 3).map((c) => `${c.slot}/${c.placeholder}`).join(", ")}.`);
  const empty = rows.filter((r) => r.emptySetupSlots.length && r.skins.length > 1);
  if (empty.length) findings.push(`${empty.length} combination(s) leave setup slots empty (fine for optional parts such as capes or bags, a bug for body parts): ${empty[0]!.skins.join(" + ")}: ${empty[0]!.emptySetupSlots.slice(0, 5).join(", ")}.`);
  const over = rows.filter((r) => r.overBudget.length);
  if (over.length) findings.push(`${over.length} of ${rows.length} combination(s) exceed the limits; worst: ${over[0]!.skins.join(" + ")}: ${over[0]!.overBudget.join("; ")}.`);
  return {
    skins: all, rows,
    ...(heaviest ? { heaviest: { skins: heaviest.skins, vertexTransforms: heaviest.worst.vertexTransforms, drawCalls: heaviest.worst.drawCalls } } : {}),
    findings,
    notes: [
      "Combinations are built like a runtime mix-and-match: Skin.addSkin in the order given (later skins win a placeholder). The default skin always applies.",
      o.pagesKnown ? "Draw calls use the atlas pages." : "Texture pages unknown: draw calls count blend mode changes only (pass atlas or pack: true).",
      o.animations === false ? "Setup pose only (animations: false)." : "Worst values cover the setup pose and every frame of every animation.",
    ],
  };
}

function withoutAnimations(data: spine.SkeletonData): spine.SkeletonData {
  const copy = Object.create(Object.getPrototypeOf(data)) as spine.SkeletonData;
  Object.assign(copy, data, { animations: [] });
  return copy;
}
