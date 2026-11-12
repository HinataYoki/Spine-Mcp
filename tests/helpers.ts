import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkeletonJson } from "../src/spine/types.js";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function loadMini(): SkeletonJson {
  return JSON.parse(readFileSync(join(FIXTURES, "mini.json"), "utf8")) as SkeletonJson;
}

type GridKey = { time?: number; curve?: unknown; vertices?: number[]; [k: string]: unknown };

const VALUE_LIMITS: Record<string, { fields: string[]; decimals: number; halves?: boolean }> = {
  rotate: { fields: ["value"], decimals: 0, halves: true },
  shear: { fields: ["x", "y"], decimals: 0, halves: true },
  translate: { fields: ["x", "y"], decimals: 0, halves: true },
  scale: { fields: ["x", "y"], decimals: 2 },
  alpha: { fields: ["value"], decimals: 2 },
  deform: { fields: [], decimals: 2 },
};

const withinDecimals = (v: number, decimals: number, halves = false) => {
  const step = halves && Math.abs(v) < 2 ? 0.5 : 10 ** -decimals;
  return Math.abs(v / step - Math.round(v / step)) < 1e-6;
};

export function frameGridIssues(anim: Record<string, unknown>, fps: number, o: { values?: boolean; owners?: string[] } = {}): string[] {
  const issues: string[] = [];
  const check = (where: string, kind: string | null, keys: GridKey[]) => {
    for (const k of keys) {
      const t = k.time ?? 0;
      if (Math.abs(t * fps - Math.round(t * fps)) >= 1e-4) issues.push(`${where} key at ${t}s is off the ${fps} fps grid`);
      if (o.values === false || !kind) continue;
      const lim = VALUE_LIMITS[kind]!;
      for (const f of lim.fields) { const v = k[f]; if (typeof v === "number" && !withinDecimals(v, lim.decimals, lim.halves)) issues.push(`${where}.${f} = ${v} at ${t}s`); }
      if (kind === "deform") for (const v of k.vertices ?? []) if (!withinDecimals(v, lim.decimals)) issues.push(`${where} vertex ${v} at ${t}s`);
    }
  };
  const mine = (owner: string) => !o.owners || o.owners.includes(owner);
  const kindOf = (prop: string) => (prop === "rotate" ? "rotate" : prop.startsWith("shear") ? "shear" : prop.startsWith("translate") ? "translate" : prop.startsWith("scale") ? "scale" : null);
  for (const [bone, tls] of Object.entries((anim.bones ?? {}) as Record<string, Record<string, GridKey[]>>)) for (const [prop, keys] of Object.entries(tls)) if (mine(bone)) check(`bones.${bone}.${prop}`, kindOf(prop), keys);
  for (const [slot, tls] of Object.entries((anim.slots ?? {}) as Record<string, Record<string, GridKey[]>>)) for (const [prop, keys] of Object.entries(tls)) if (mine(slot)) check(`slots.${slot}.${prop}`, prop === "alpha" ? "alpha" : null, keys);
  for (const bySlot of Object.values((anim.attachments ?? {}) as Record<string, Record<string, Record<string, Record<string, GridKey[]>>>>)) for (const [slot, byAtt] of Object.entries(bySlot)) for (const [att, tls] of Object.entries(byAtt)) if (tls.deform && mine(slot)) check(`deform.${slot}.${att}`, "deform", tls.deform);
  if (Array.isArray(anim.events)) check("events", null, anim.events as GridKey[]);
  return issues;
}

export function keysPerTimeline(anim: Record<string, unknown>, owners: string[]): number {
  let most = 0;
  for (const [bone, tls] of Object.entries((anim.bones ?? {}) as Record<string, Record<string, unknown[]>>)) if (owners.includes(bone)) for (const keys of Object.values(tls)) most = Math.max(most, keys.length);
  return most;
}
