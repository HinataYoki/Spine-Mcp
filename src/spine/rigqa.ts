import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { STRETCH_DEGREES, stressFolds, stressStretch } from "./folds.js";
import { folderImages, OPEN_REACH, stressJoints } from "./gaps.js";
import { stretchedRegions } from "./intake.js";
import { artOutside, meshFits, mostlyEmpty, type MeshFit } from "./meshfit.js";
import { loadSkeletonData } from "./runtime.js";
import type { AnimationJson, AttachmentJson, SkeletonJson } from "./types.js";

export type QaSeverity = "warning" | "info";

export interface QaFinding {
  severity: QaSeverity;
  code: string;
  message: string;
  items?: string[];
}

export interface RigQaOptions {
  /** Folder the skeleton's `images` path is relative to (the .spine or .json file's folder). Image checks are skipped without it. */
  baseDir?: string;
  /** Bone influences per vertex above which a mesh is reported (default 4). */
  maxInfluences?: number;
  /** Other skeletons of the same project: images they use are not reported as unused. */
  otherSkeletons?: SkeletonJson[];
}

export interface RigQaResult {
  counts: { bones: number; slots: number; skins: number; attachments: number; meshes: number; weightedMeshes: number; animations: number };
  findings: QaFinding[];
  summary: { warnings: number; infos: number };
}

const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".webp"];
const DEFAULT_BONE = /^bone\d*$/i;
const SIDE_TAGS: [string, RegExp][] = [
  ["left/right", /(^|[^a-z])(left|right)/i],
  ["l/r", /(^|[_\-. ])(l|r)([_\-. ]|$)/i],
  ["L/R suffix", /[a-z0-9](L|R)$/],
  ["front/back", /(^|[^a-z])(front|back|rear)/i],
];
const cap = (list: string[], n = 20) => (list.length > n ? [...list.slice(0, n), `... ${list.length - n} more`] : list);

type AttachmentRef = { skin: string; slot: string; key: string; att: AttachmentJson };

function* attachments(doc: SkeletonJson): Generator<AttachmentRef> {
  for (const skin of doc.skins ?? []) {
    for (const [slot, atts] of Object.entries(skin.attachments ?? {})) {
      for (const [key, att] of Object.entries(atts)) yield { skin: skin.name, slot, key, att };
    }
  }
}

/** Per vertex bone counts and weight sums of a weighted mesh, or null when unweighted. */
function vertexWeights(att: AttachmentJson): { influences: number[]; sums: number[]; tiny: number } | null {
  const uvs = att.uvs ?? [], v = att.vertices ?? [];
  if (v.length <= uvs.length) return null;
  const influences: number[] = [], sums: number[] = [];
  let tiny = 0;
  for (let i = 0; i < v.length;) {
    const n = v[i++]!;
    let sum = 0;
    for (let j = 0; j < n; j++, i += 4) {
      const w = v[i + 3]!;
      sum += w;
      if (w > 0 && w < 0.01) tiny++;
    }
    influences.push(n);
    sums.push(sum);
  }
  return { influences, sums, tiny };
}

function keyedNames(doc: SkeletonJson) {
  const bones = new Set<string>(), attachmentKeys = new Map<string, Set<string>>(), events = new Set<string>(), skinsInAnims = new Set<string>();
  for (const anim of Object.values(doc.animations ?? {}) as AnimationJson[]) {
    for (const b of Object.keys(anim.bones ?? {})) bones.add(b);
    for (const [slot, tls] of Object.entries(anim.slots ?? {})) {
      for (const k of tls.attachment ?? []) if (k.name) (attachmentKeys.get(slot) ?? attachmentKeys.set(slot, new Set()).get(slot)!).add(k.name);
    }
    for (const e of anim.events ?? []) if (typeof e.name === "string") events.add(e.name);
    for (const skin of Object.keys(anim.attachments ?? {})) skinsInAnims.add(skin);
  }
  return { bones, attachmentKeys, events, skinsInAnims };
}

/** Read-only rig hygiene report: naming, unused parts, weights, image files. Complements spine_validate (which checks that data is loadable and consistent). */
export function rigQa(doc: SkeletonJson, o: RigQaOptions = {}): RigQaResult {
  const findings: QaFinding[] = [];
  const add = (severity: QaSeverity, code: string, message: string, items?: string[]) => {
    if (!items || items.length) findings.push({ severity, code, message, ...(items ? { items: cap(items) } : {}) });
  };
  const maxInf = o.maxInfluences ?? 4;
  const slots = doc.slots ?? [];
  const keyed = keyedNames(doc);
  const all = [...attachments(doc)];

  // Naming
  const names: [string, string][] = [
    ...doc.bones.map((b) => ["bone", b.name] as [string, string]), ...slots.map((s) => ["slot", s.name] as [string, string]),
    ...(doc.constraints ?? []).map((c) => [c.type, c.name] as [string, string]), ...(doc.skins ?? []).map((s) => ["skin", s.name] as [string, string]),
  ];
  add("warning", "name-whitespace", "Names with leading/trailing or double spaces (easy to mistype in code and maps)", names.filter(([, n]) => n !== n.trim() || /\s{2}/.test(n)).map(([k, n]) => `${k} "${n}"`));
  for (const kind of ["bone", "slot"]) {
    const byLower = new Map<string, string[]>();
    for (const [k, n] of names) if (k === kind) (byLower.get(n.toLowerCase()) ?? byLower.set(n.toLowerCase(), []).get(n.toLowerCase())!).push(n);
    add("warning", "name-case-clash", `${kind === "bone" ? "Bone" : "Slot"} names that differ only in case (break case-insensitive lookups and transfers)`, [...byLower.values()].filter((g) => g.length > 1).map((g) => g.join(" / ")));
  }
  add("info", "default-bone-name", "Bones still named like Spine's defaults (bone, bone2, ...)", doc.bones.filter((b) => DEFAULT_BONE.test(b.name)).map((b) => b.name));
  const sideStyles = SIDE_TAGS.filter(([, re]) => doc.bones.some((b) => re.test(b.name))).map(([label]) => label);
  const lr = sideStyles.filter((s) => s !== "front/back");
  if (lr.length > 1) add("info", "side-naming-mixed", `Bones use more than one left/right naming style (${lr.join(", ")}); mirror and swap pair detection works best with one`);
  // Image names (attachment paths) end up as atlas regions, PNG files and code lookups: spaces and mixed styles there
  // break searches and scripts the same way (a game's atlases had "Hero and Fox shadow", "Fox-eyebrow-L" next to
  // "drop1", and skeleton files ending in a space).
  const images = [...new Set(all.filter(({ att }) => !att.type || ["region", "mesh", "linkedmesh"].includes(att.type)).map(({ key, att }) => (att.path as string | undefined) ?? (att.name as string | undefined) ?? key))];
  add("info", "image-name-spaces", "Image names with spaces (atlas regions and PNG files; awkward in scripts, command lines and searches)", images.filter((n) => /\s/.test(n)).map((n) => `"${n}"`));
  const base = (n: string) => n.split("/").pop()!;
  // Each name counted once: "_" only, "-" only, or both in one name.
  const under = images.filter((n) => base(n).includes("_") && !base(n).includes("-")), hyphen = images.filter((n) => base(n).includes("-") && !base(n).includes("_"));
  const both = images.filter((n) => base(n).includes("_") && base(n).includes("-"));
  if ((hyphen.length && under.length) || both.length) add("info", "image-name-style-mixed", `Image names mix separators: ${under.length} with "_", ${hyphen.length} with "-"${both.length ? `, ${both.length} with both` : ""} (e.g. ${[under[0], hyphen[0], both[0]].filter(Boolean).join(", ")}); pick one so names sort and search together`);
  // The first letter after a side tag (L_hand, R-arm): a capital L or R there is the side, not a style.
  const start = (n: string) => base(n).replace(/^[LR][_\-. ]/, "");
  const lower = images.filter((n) => /^[a-z]/.test(start(n))), upper = images.filter((n) => /^[A-Z]/.test(start(n)));
  if (lower.length && upper.length && Math.min(lower.length, upper.length) >= 2) add("info", "image-name-case-mixed", `Image names mix lowercase and capitalised starts (${upper.length} vs ${lower.length}); lowercase: ${cap(lower, 8).join(", ")}`);

  // Unused parts
  const children = new Set(doc.bones.map((b) => b.parent).filter((p): p is string => !!p));
  const slotBones = new Set(slots.map((s) => s.bone));
  const constraintBones = new Set<string>();
  for (const c of doc.constraints ?? []) for (const b of [...(c.bones ?? []), c.bone, c.target, c.source]) if (typeof b === "string") constraintBones.add(b);
  const weightBones = new Set<string>();
  let meshes = 0, weighted = 0;
  for (const { att } of all) {
    if (att.type !== "mesh" && att.type !== "path" && att.type !== "clipping" && att.type !== "boundingbox") continue;
    if (att.type === "mesh") meshes++;
    const uvs = att.uvs ?? [], v = att.vertices ?? [];
    const vc = att.type === "mesh" ? uvs.length / 2 : (att.vertexCount ?? 0);
    if (v.length <= (att.type === "mesh" ? uvs.length : vc * 2)) continue;
    if (att.type === "mesh") weighted++;
    for (let i = 0; i < v.length;) { const n = v[i++]!; for (let j = 0; j < n; j++, i += 4) { const b = doc.bones[v[i]!]; if (b) weightBones.add(b.name); } }
  }
  const pointBones = new Set(all.filter(({ att }) => att.type === "point").map(({ slot }) => slots.find((s) => s.name === slot)?.bone).filter((b): b is string => !!b));
  add("info", "unused-bone", "Leaf bones with no slot, weights, constraint or animation keys (safe to delete unless code looks them up by name)",
    doc.bones.slice(1).filter((b) => !children.has(b.name) && !slotBones.has(b.name) && !constraintBones.has(b.name) && !weightBones.has(b.name) && !keyed.bones.has(b.name) && !pointBones.has(b.name)).map((b) => b.name));

  const shown = new Map<string, Set<string>>();
  for (const s of slots) if (s.attachment) (shown.get(s.name) ?? shown.set(s.name, new Set()).get(s.name)!).add(s.attachment);
  for (const [slot, set] of keyed.attachmentKeys) for (const n of set) (shown.get(slot) ?? shown.set(slot, new Set()).get(slot)!).add(n);
  // 4.3 linked meshes name their source mesh (`source`, older data `parent`), optionally in another slot.
  const linkedParents = new Set(all.filter(({ att }) => att.type === "linkedmesh" && (att.source || att.parent)).map(({ slot, att }) => `${(att.slot as string | undefined) ?? slot}/${(att.source as string | undefined) ?? att.parent}`));
  add("info", "attachment-never-shown", "Attachments no setup pose or attachment key ever shows (unused, or switched on from code)",
    all.filter(({ slot, key, att }) => att.type !== "clipping" && att.type !== "point" && att.type !== "boundingbox" && !shown.get(slot)?.has(key) && !linkedParents.has(`${slot}/${key}`)).map(({ skin, slot, key }) => `${skin}/${slot}/${key}`));
  const slotsWithAtts = new Set(all.map((a) => a.slot));
  add("info", "empty-slot", "Slots with no attachment in any skin", slots.filter((s) => !slotsWithAtts.has(s.name)).map((s) => s.name));
  add("info", "unused-event", "Events defined but never keyed", Object.keys(doc.events ?? {}).filter((e) => !keyed.events.has(e)));

  // Setup pose
  add("info", "zero-scale-bone", "Bones with scale 0 in the setup pose (children and attachments are invisible)", doc.bones.filter((b) => b.scaleX === 0 || b.scaleY === 0).map((b) => b.name));
  add("info", "negative-scale-bone", "Bones flipped with negative scale in the setup pose (mirroring and IK behave differently on flipped bones)", doc.bones.filter((b) => (b.scaleX ?? 1) < 0 || (b.scaleY ?? 1) < 0).map((b) => b.name));

  // Weights under stress: each weighting bone turned alone from the setup pose until a mesh folds.
  let stress: ReturnType<typeof stressFolds> = [];
  try { stress = stressFolds(loadSkeletonData(doc)); } catch { /* a skeleton spine-core cannot load: spine_validate reports it */ }
  add("info", "fold-prone-weights", "Bones whose turn from the setup pose folds a mesh they weight, at the smallest of 15/30/45/60/90 degrees (a fold earlier than the joint bends in use points to a weight step or a vertex on the wrong side)",
    stress.slice(0, 12).map((s) => `${s.bone} at ${s.degrees}°: ${s.attachments.slice(0, 3).map((a) => `${a.attachment} ${a.areaPercent}%`).join(", ")}`));

  // Weights under a small turn: a joint that already stretches at idle angles bends away from its pivot.
  let stretch: ReturnType<typeof stressStretch> = [];
  try { stretch = stressStretch(loadSkeletonData(doc)); } catch { /* reported by spine_validate */ }
  add("info", "stretch-prone-weights", `Bones whose ${STRETCH_DEGREES}° turn from the setup pose stretches a mesh they move (largest edge length change) because vertices along the bone do not follow it: the mesh bends at the next ring of weights, not at the pivot. Weight those vertices to the bone and blend only around its pivot (or leave them if they are pinned on purpose)`,
    stretch.slice(0, 12).map((s) => `${s.bone}: ${s.attachments.slice(0, 3).map((a) => `${a.attachment} ${a.stretchPercent}% (${a.along} vertices along it weighted to ${a.alongBones.join(", ")})`).join(", ")}`));

  // Joints under stress: each joint between two parts turned alone until the background reaches its pivot.
  let joints: ReturnType<typeof stressJoints> = [];
  const jointImages = o.baseDir ? resolve(o.baseDir, doc.skeleton.images ?? "./images/") : null;
  try { joints = stressJoints(loadSkeletonData(doc), jointImages && existsSync(jointImages) ? folderImages(jointImages) : undefined); } catch { /* reported by spine_validate */ }
  add("info", "gap-prone-joints", `Joints between two parts whose turn from the setup pose opens a gap at the pivot (background within ${OPEN_REACH} of the joint's radius), at the smallest of 30/60/90/120 degrees, sign = direction: overlap the parts past the pivot and round them around it, or cap the joint`,
    joints.slice(0, 12).map((j) => `${j.parent} > ${j.bone} at ${j.degrees}°${j.skin === "default" ? "" : ` (skin ${j.skin})`}`));

  // Weights
  const tooMany: string[] = [], badSum: string[] = [], tinyW: string[] = [];
  for (const { skin, slot, key, att } of all) {
    if (att.type !== "mesh") continue;
    const w = vertexWeights(att);
    if (!w) continue;
    const id = `${skin}/${slot}/${key}`;
    const over = w.influences.filter((n) => n > maxInf).length;
    if (over) tooMany.push(`${id}: ${over} vertex(es), up to ${Math.max(...w.influences)} bones`);
    const off = w.sums.filter((s) => Math.abs(s - 1) > 0.005).length;
    if (off) badSum.push(`${id}: ${off} vertex(es)`);
    if (w.tiny) tinyW.push(`${id}: ${w.tiny} weight(s)`);
  }
  add("warning", "weights-not-normalized", "Mesh vertices whose weights do not add up to 1 (the mesh drifts from its bones)", badSum);
  add("info", "too-many-influences", `Mesh vertices weighted to more than ${maxInf} bones (CPU skinning cost grows with every influence; prune with Weights > Prune)`, tooMany);
  add("info", "tiny-weights", "Weights under 1% (cost without visible effect; prune them)", tinyW);

  // Image files
  if (o.baseDir) {
    const imagesDir = resolve(o.baseDir, doc.skeleton.images ?? "./images/");
    if (!existsSync(imagesDir) || !statSync(imagesDir).isDirectory()) {
      add("info", "images-folder-missing", `Images folder not found: ${imagesDir} (image checks skipped)`);
    } else {
      const files = listImages(imagesDir);
      const have = new Set(files.map((f) => f.replace(/\.[^.]+$/, "")));
      const needed = imageRefs(doc);
      const usedAnywhere = new Set([...needed.keys(), ...(o.otherSkeletons ?? []).flatMap((d) => [...imageRefs(d).keys()])]);
      add("warning", "image-missing", `Attachments whose image is not in ${relative(o.baseDir, imagesDir) || "."} (they render empty and fail packing)`,
        [...needed].filter(([img]) => !have.has(img)).map(([img, where]) => `${img} (${where})`));
      add("info", "image-unused", "Image files no attachment uses (packed into the atlas only if the pack folder includes them)", files.filter((f) => !usedAnywhere.has(f.replace(/\.[^.]+$/, ""))));
      // Meshes against their images: art cut off, a file no longer the size the mesh was made for, mostly empty meshes.
      let fits: MeshFit[] = [];
      try { fits = meshFits(doc, folderImages(imagesDir)).fits; } catch { /* reported by spine_validate */ }
      add("warning", "mesh-image-resized", "Mesh images whose file is not the size the mesh was made for (Spine stretches the new file over the old UVs: re-mesh it, or bring the old size back)",
        fits.filter((f) => f.resized).map((f) => `${f.image}: mesh ${f.resized!.mesh.join("x")}, file ${f.resized!.image.join("x")}`));
      add("warning", "region-image-resized", "Regions drawn at another size than their image: Spine imports them at that size but writes the image's size back on every export, so the region shrinks in the game data and after any round trip (move the ratio into scaleX/scaleY; spine_rig_edit and spine_import_layers do it on the way in)",
        stretchedRegions(doc, folderImages(imagesDir)).map((r) => `${r.id}: drawn ${r.size.join("x")}, file ${r.file.join("x")}`));
      add("info", "mesh-art-outside", "Art outside every mesh drawing the image (cut off, never drawn): fine when another part covers it, otherwise widen the mesh's hull",
        fits.filter(artOutside).map((f) => `${f.image}: ${f.outsidePx} px (${f.outsidePercent}%), up to ${f.farthestPx} px out`));
      add("info", "mesh-mostly-empty", "Meshes drawn mostly over transparent pixels (fill cost for nothing; trace the hull closer to the art)",
        fits.filter(mostlyEmpty).map((f) => `${f.image}: ${f.emptyInsidePercent}% of the mesh (${f.emptyInsidePx} px)`));
    }
  }

  return {
    counts: {
      bones: doc.bones.length, slots: slots.length, skins: (doc.skins ?? []).length, attachments: all.length, meshes, weightedMeshes: weighted,
      animations: Object.keys(doc.animations ?? {}).length,
    },
    findings,
    summary: { warnings: findings.filter((f) => f.severity === "warning").length, infos: findings.filter((f) => f.severity === "info").length },
  };
}

/** Image name (no extension) -> first attachment using it, sequence frames expanded. */
function imageRefs(doc: SkeletonJson): Map<string, string> {
  const needed = new Map<string, string>();
  for (const { skin, slot, key, att } of attachments(doc)) {
    if (att.type && att.type !== "region" && att.type !== "mesh" && att.type !== "linkedmesh") continue;
    const base = att.path ?? att.name ?? key;
    const seq = att.sequence as { count?: number; start?: number; digits?: number } | undefined;
    if (seq?.count) for (let i = 0; i < seq.count; i++) needed.set(base + String((seq.start ?? 1) + i).padStart(seq.digits ?? 0, "0"), `${skin}/${slot}/${key}`);
    else if (!needed.has(base)) needed.set(base, `${skin}/${slot}/${key}`);
  }
  return needed;
}

function listImages(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) out.push(...listImages(join(dir, e.name), `${prefix}${e.name}/`));
    else if (IMAGE_EXT.some((x) => e.name.toLowerCase().endsWith(x))) out.push(prefix + e.name);
  }
  return out;
}
