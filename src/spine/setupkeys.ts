import { iterateTimelines } from "./inspect.js";
import type { AnimationJson, Key, SkeletonJson } from "./types.js";

/**
 * Timelines other animations key that this one does not. spine-unity's SkeletonMecanim (autoReset, MixNext, the
 * default) applies the outgoing clip at full weight through the whole transition and resets what it keyed to the setup
 * pose once it ends: whatever the incoming clip does not key snaps back in one frame. spine-unity's documentation asks
 * for these keys ("Required Additional Keys"); AnimationState mixes them out on its own.
 */
export function missingTimelines(skeleton: SkeletonJson, target: string, from?: string[]): { kind: string; owner: string; from: string[] }[] {
  const anims = skeleton.animations ?? {};
  const own = new Set([...iterateTimelines(anims[target] ?? {})].map((t) => `${t.kind}|${t.owner}`));
  const sources = (from ?? Object.keys(anims)).filter((n) => n !== target);
  const missing = new Map<string, { kind: string; owner: string; from: string[] }>();
  // Bones a physics constraint drives are the simulation's: a key there fights it (a baked animation keys them, with
  // the physics mix at 0; the mix timeline itself is what the incoming animation needs back).
  const physics = new Set((skeleton.constraints ?? []).filter((c) => c.type === "physics" && c.bone).map((c) => c.bone!));
  for (const n of sources) {
    const a = anims[n];
    if (!a) throw new Error(`Animation "${n}" not found`);
    for (const t of iterateTimelines(a)) {
      if (!t.keys.length || t.kind === "events" || t.kind.endsWith(".reset")) continue;
      if (t.kind.startsWith("bone.") && physics.has(t.owner)) continue;
      const id = `${t.kind}|${t.owner}`;
      if (own.has(id)) continue;
      const m = missing.get(id) ?? { kind: t.kind, owner: t.owner, from: [] };
      m.from.push(n);
      missing.set(id, m);
    }
  }
  return [...missing.values()];
}

const BONE_SETUP: Record<string, Key> = {
  rotate: { value: 0 }, translate: { x: 0, y: 0 }, translatex: { value: 0 }, translatey: { value: 0 },
  scale: { x: 1, y: 1 }, scalex: { value: 1 }, scaley: { value: 1 }, shear: { x: 0, y: 0 }, shearx: { value: 0 }, sheary: { value: 0 },
};

/** The setup pose of one timeline as a single key at 0, or null when it cannot be keyed that way. */
function setupKey(skeleton: SkeletonJson, kind: string, owner: string): Key | null {
  const [section, prop] = kind.split(".") as [string, string | undefined];
  if (section === "bone") {
    if (prop === "inherit") return { inherit: skeleton.bones.find((b) => b.name === owner)?.inherit ?? "normal" };
    return BONE_SETUP[prop!] ? { ...BONE_SETUP[prop!] } : null;
  }
  if (section === "slot") {
    const slot = skeleton.slots?.find((s) => s.name === owner);
    if (!slot) return null;
    const color = (slot.color ?? "ffffffff").padEnd(8, "f"), dark = slot.dark ?? "000000";
    switch (prop) {
      case "attachment": return slot.attachment ? { name: slot.attachment } : {};
      case "rgba": return { color };
      case "rgb": return { color: color.slice(0, 6) };
      case "alpha": return { value: +(parseInt(color.slice(6, 8), 16) / 255).toFixed(4) };
      case "rgba2": return { light: color, dark };
      case "rgb2": return { light: color.slice(0, 6), dark };
      default: return null;
    }
  }
  const c = skeleton.constraints?.find((x) => x.name === owner);
  if (section === "ik" && c) {
    return { mix: (c.mix as number | undefined) ?? 1, softness: (c.softness as number | undefined) ?? 0, bendPositive: (c.bendPositive as boolean | undefined) ?? true, compress: !!c.compress, stretch: !!c.stretch };
  }
  if (section === "transform" && c) {
    const mr = (c.mixRotate as number | undefined) ?? 1, mx = (c.mixX as number | undefined) ?? 1, msx = (c.mixScaleX as number | undefined) ?? 1;
    return { mixRotate: mr, mixX: mx, mixY: (c.mixY as number | undefined) ?? mx, mixScaleX: msx, mixScaleY: (c.mixScaleY as number | undefined) ?? msx, mixShearY: (c.mixShearY as number | undefined) ?? 1 };
  }
  if (section === "path" && c) {
    if (prop === "position") return { value: (c.position as number | undefined) ?? 0 };
    if (prop === "spacing") return { value: (c.spacing as number | undefined) ?? 0 };
    if (prop === "mix") { const mx = (c.mixX as number | undefined) ?? 1; return { mixRotate: (c.mixRotate as number | undefined) ?? 1, mixX: mx, mixY: (c.mixY as number | undefined) ?? mx }; }
  }
  if (section === "physics" && c && prop) {
    const defaults: Record<string, number> = { inertia: 0.5, strength: 100, damping: 0.85, mass: 1, wind: 0, gravity: 0, mix: 1 };
    const field = prop === "mass" ? "mass" : prop;
    if (field in defaults) return { value: (c[field] as number | undefined) ?? defaults[field]! };
  }
  if (kind === "drawOrder") return {};
  if (section === "attachment" && prop === "deform") return {};
  return null;
}

/**
 * setupKeys: a key at 0 with the setup pose for every timeline the other animations (or `from`) key and this one
 * does not, so a SkeletonMecanim transition into it blends those properties back instead of snapping at its end.
 */
export function addSetupKeys(anim: AnimationJson, skeleton: SkeletonJson, target: string | undefined, from?: string[]): { animation: AnimationJson; notes: string[] } {
  const out: AnimationJson = structuredClone(anim);
  const doc = { ...skeleton, animations: { ...(skeleton.animations ?? {}), [target ?? "\u0000self"]: out } };
  const missing = missingTimelines(doc, target ?? "\u0000self", from);
  const added: string[] = [], skipped: string[] = [];
  for (const m of missing) {
    const key = setupKey(skeleton, m.kind, m.owner);
    if (!key) { skipped.push(`${m.kind} ${m.owner}`.trim()); continue; }
    const [section, prop] = m.kind.split(".") as [string, string | undefined];
    if (section === "bone" || section === "slot" || section === "path" || (section === "physics" && prop)) {
      const map = ((out as Record<string, unknown>)[section === "bone" ? "bones" : section === "slot" ? "slots" : section] ??= {}) as Record<string, Record<string, Key[]>>;
      ((map[m.owner] ??= {})[prop!] = [key]);
    } else if (section === "ik" || section === "transform") {
      ((out[section] ??= {})[m.owner] = [key]);
    } else if (m.kind === "drawOrder") {
      out.drawOrder = [key];
    } else if (section === "attachment") {
      const [skin, slot, att] = m.owner.split("/") as [string, string, string];
      (((out.attachments ??= {})[skin] ??= {})[slot] ??= {})[att] = { deform: [key] };
    } else { skipped.push(`${m.kind} ${m.owner}`.trim()); continue; }
    added.push(`${m.kind} ${m.owner}`.trim());
  }
  const notes = [
    added.length
      ? `setupKeys: ${added.length} timeline(s) keyed to the setup pose at 0 (${added.slice(0, 12).join(", ")}${added.length > 12 ? ", ..." : ""}); SkeletonMecanim transitions into this animation now blend them back instead of snapping when the transition ends.`
      : "setupKeys: nothing to add; this animation already keys everything the others key.",
  ];
  if (skipped.length) notes.push(`Not keyable as a setup key (left as they are): ${skipped.slice(0, 8).join(", ")}${skipped.length > 8 ? ", ..." : ""}.`);
  return { animation: out, notes };
}
