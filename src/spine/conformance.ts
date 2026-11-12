/**
 * Spine version conformance: facts about the editor CLI that spine-mcp depends on, recorded per editor version
 * (scripts/conformance.mjs) and compared against a saved baseline, so a new Spine release shows what changed.
 */

export interface ProbeResult {
  id: string;
  title: string;
  /** GOTCHAS / research ids the probe re-checks. */
  refs: string[];
  /** The spine-mcp code that relies on this behavior: where to look when it changes. */
  protects: string;
  /** A safety assumption (writes, rollback, version guard): failing it means spine-mcp must not be used with this version. */
  critical: boolean;
  /** null when the probe was skipped. */
  ok: boolean | null;
  /** Deterministic observations (no timings, paths or hashes; the version under test is `<v>`). */
  facts: Record<string, unknown>;
  note?: string;
}

export interface Baseline {
  version: string;
  recordedAt: string;
  probes: Record<string, { ok: boolean | null; facts: Record<string, unknown> }>;
}

export type ProbeStatus = "same" | "changed" | "new" | "missing" | "failed" | "skipped";

export interface ProbeComparison {
  id: string;
  critical: boolean;
  status: ProbeStatus;
  /** `fact: before -> after` lines for changed probes. */
  changes: string[];
  protects?: string;
}

/** Replaces each token value (e.g. the version under test, the work folder) by its name, recursively in strings. */
export function normalizeFacts<T>(value: T, tokens: Record<string, string>): T {
  const pairs = Object.entries(tokens).filter(([, v]) => v).sort((a, b) => b[1].length - a[1].length);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return pairs.reduce((s, [name, val]) => s.split(val).join(name), v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

const show = (v: unknown) => (v === undefined ? "(none)" : JSON.stringify(v));

/** Compares a run with a baseline: failed critical probes first, then changes, then the rest. */
export function compareRun(baseline: Baseline | null, results: ProbeResult[]): ProbeComparison[] {
  const out: ProbeComparison[] = results.map((r) => {
    const base = baseline?.probes[r.id];
    const common = { id: r.id, critical: r.critical, protects: r.protects };
    if (r.ok === null) return { ...common, status: "skipped", changes: r.note ? [r.note] : [] };
    if (r.ok === false) return { ...common, status: "failed", changes: r.note ? [r.note] : [] };
    if (!base) return { ...common, status: "new", changes: [] };
    const keys = [...new Set([...Object.keys(base.facts), ...Object.keys(r.facts)])];
    const changes = keys
      .filter((k) => JSON.stringify(base.facts[k]) !== JSON.stringify(r.facts[k]))
      .map((k) => `${k}: ${show(base.facts[k])} -> ${show(r.facts[k])}`);
    if (base.ok !== r.ok) changes.unshift(`ok: ${base.ok} -> ${r.ok}`);
    return { ...common, status: changes.length ? "changed" : "same", changes };
  });
  for (const id of Object.keys(baseline?.probes ?? {})) {
    if (!results.some((r) => r.id === id)) out.push({ id, critical: false, status: "missing", changes: [] });
  }
  const rank = (c: ProbeComparison) => (c.status === "failed" ? (c.critical ? 0 : 1) : c.status === "changed" ? 2 : c.status === "same" ? 4 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

/** Process exit code for a run: 1 = a critical probe failed, 2 = behavior differs from the baseline, 0 = same. */
export function exitCode(comparisons: ProbeComparison[]): number {
  if (comparisons.some((c) => c.status === "failed" && c.critical)) return 1;
  if (comparisons.some((c) => c.status === "failed" || c.status === "changed" || c.status === "missing")) return 2;
  return 0;
}

export function toBaseline(version: string, results: ProbeResult[], recordedAt = new Date().toISOString()): Baseline {
  return { version, recordedAt, probes: Object.fromEntries(results.map((r) => [r.id, { ok: r.ok, facts: r.facts }])) };
}
