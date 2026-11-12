// Art checks on a layered PSD before it becomes a rig: joints that will open a gap when they turn, parts nobody sees,
// specks, and art far bigger than it will be shown.
import { suggestRig, type Part } from "./autorig.js";
import { cutQa, type SourceImage } from "./cutqa.js";

export interface ArtFinding { severity: "warning" | "info"; code: string; message: string; parts: string[] }

const alpha = (p: Part, x: number, y: number) => p.data[(y * p.width + x) * 4 + 3]!;

/**
 * Checks the parts of a PSD (bottom to top, as placed): parts that touch without overlapping (a rotation there opens
 * a gap), parts entirely covered by the layers above them, parts only a few pixels big, and art much larger than
 * `targetHeight` (the height it will be shown at, in pixels).
 */
export function artQa(parts: Part[], o: { targetHeight?: number; touch?: number; joints?: [string, string][]; source?: SourceImage } = {}): ArtFinding[] {
  const out: ArtFinding[] = [];
  // Only joints count (parts merely lying side by side are fine): the given ones, or the suggested skeleton's.
  const joints = o.joints ?? suggestRig(parts).bones.filter((b) => b.parent).map((b) => [b.parent!, b.name] as [string, string]);
  const isJoint = (a: string, b: string) => joints.some(([p, c]) => (p === a && c === b) || (p === b && c === a));
  const S = 2, touch = o.touch ?? 10;
  const opaque = parts.map((p) => { const set = new Set<string>(); for (let y = 0; y < p.height; y += S) for (let x = 0; x < p.width; x += S) if (alpha(p, x, y) > 64) set.add(`${Math.floor((p.left + x) / S)},${Math.floor((p.top + y) / S)}`); return set; });
  const gaps: string[] = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const A = parts[i]!, B = parts[j]!;
    if (!isJoint(A.name, B.name)) continue;
    if (A.left > B.left + B.width + touch || B.left > A.left + A.width + touch || A.top > B.top + B.height + touch || B.top > A.top + A.height + touch) continue;
    const [small, big] = opaque[i]!.size < opaque[j]!.size ? [opaque[i]!, opaque[j]!] : [opaque[j]!, opaque[i]!];
    let overlap = 0;
    for (const k of small) if (big.has(k)) overlap++;
    if (overlap) continue;
    // Closest opaque cells: a gap of a few pixels is a joint without an overlap.
    let best = Infinity;
    const cells = (s: Set<string>) => [...s].map((k) => k.split(",").map(Number) as [number, number]);
    const ca = cells(opaque[i]!), cb = cells(opaque[j]!);
    for (const [ax, ay] of ca) for (const [bx, by] of cb) { const d = Math.hypot(ax - bx, ay - by); if (d < best) best = d; }
    if (best * S <= touch) gaps.push(`${A.name} / ${B.name} (about ${Math.round(best * S)} px apart)`);
  }
  if (gaps.length) out.push({ severity: "warning", code: "joint-gap", message: "Joints whose parts meet without overlapping: turning there opens a gap. Draw one part on under the other, past the joint.", parts: gaps });
  // Covered: every opaque cell of a part lies under opaque cells of parts above it.
  const covered: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (!opaque[i]!.size) continue;
    let hidden = true;
    for (const k of opaque[i]!) { if (!opaque.slice(i + 1).some((s) => s.has(k))) { hidden = false; break; } }
    if (hidden) covered.push(parts[i]!.name);
  }
  if (covered.length) out.push({ severity: "info", code: "covered", message: "Parts hidden under the layers above them in the setup pose (fine for things that show when others move; otherwise texture memory for nothing).", parts: covered });
  const specks = parts.filter((p) => Math.min(p.width, p.height) < 6).map((p) => `${p.name} (${p.width}x${p.height})`);
  if (specks.length) out.push({ severity: "info", code: "speck", message: "Parts only a few pixels big: stray pixels, or details that may not need their own slot.", parts: specks });
  if (o.targetHeight) {
    const top = Math.min(...parts.map((p) => p.top)), bottom = Math.max(...parts.map((p) => p.top + p.height)), h = bottom - top;
    if (h > o.targetHeight * 2) out.push({ severity: "warning", code: "oversized", message: `The art is ${h} px tall and will be shown at about ${o.targetHeight}: import with scale ${(o.targetHeight * 1.5 / h).toFixed(2)} (1.5x headroom) to save texture memory.`, parts: [] });
  }
  out.push(...cutQa(parts, { ...(o.joints ? { joints: o.joints } : {}), ...(o.source ? { source: o.source } : {}) }).findings);
  return out;
}
