import type { ImageLookup } from "./gaps.js";
import type { AttachmentJson, Key, SkeletonJson } from "./types.js";

export interface WeightOrder { meshes: string[]; vertices: number }
export interface StretchedRegion { id: string; image: string; size: [number, number]; file: [number, number] }

function weightedVertexCount(att: AttachmentJson): number | null {
  if ((att.type ?? "region") !== "mesh" || !att.uvs || !att.vertices || att.vertices.length === att.uvs.length) return null;
  return att.uvs.length / 2;
}

function eachMesh(doc: SkeletonJson, fn: (skin: string, slot: string, name: string, att: AttachmentJson) => void) {
  for (const skin of doc.skins ?? []) {
    for (const [slot, atts] of Object.entries(skin.attachments ?? {})) {
      for (const [name, att] of Object.entries(atts)) fn(skin.name, slot, name, att);
    }
  }
}

function vertexBones(att: AttachmentJson, count: number): number[][] {
  const v = att.vertices!, out: number[][] = [];
  for (let i = 0, k = 0; k < count && i < v.length; k++) {
    const n = v[i++]!;
    out.push(Array.from({ length: n }, (_, j) => v[i + j * 4]!));
    i += n * 4;
  }
  return out;
}

function hasCycle(edges: Map<number, Set<number>>): boolean {
  const indegree = new Map<number, number>();
  for (const [from, tos] of edges) { if (!indegree.has(from)) indegree.set(from, 0); for (const to of tos) indegree.set(to, (indegree.get(to) ?? 0) + 1); }
  const ready = [...indegree].filter(([, d]) => d === 0).map(([n]) => n);
  let seen = 0;
  while (ready.length) {
    const n = ready.pop()!;
    seen++;
    for (const to of edges.get(n) ?? []) { const d = indegree.get(to)! - 1; indegree.set(to, d); if (!d) ready.push(to); }
  }
  return seen < indegree.size;
}

export function weightOrderConflicts(att: AttachmentJson): number {
  const count = weightedVertexCount(att);
  if (count === null) return 0;
  const lists = vertexBones(att, count), edges = new Map<number, Set<number>>();
  for (const bones of lists) for (let x = 0; x < bones.length; x++) for (let y = x + 1; y < bones.length; y++) {
    if (bones[x] !== bones[y]) (edges.get(bones[x]!) ?? edges.set(bones[x]!, new Set()).get(bones[x]!)!).add(bones[y]!);
  }
  const conflicting = lists.filter((bones) => bones.some((a, x) => bones.slice(x + 1).some((b) => edges.get(b)?.has(a)))).length;
  return conflicting || (hasCycle(edges) ? 1 : 0);
}

export function weightOrderReport(doc: SkeletonJson): WeightOrder {
  const meshes: string[] = [];
  let vertices = 0;
  eachMesh(doc, (skin, slot, name, att) => {
    const bad = weightOrderConflicts(att);
    if (bad) { meshes.push(`${skin}/${slot}/${name} (${bad} vertices)`); vertices += bad; }
  });
  return { meshes, vertices };
}

export function sortAttachmentWeights(att: AttachmentJson): number[] | null {
  const count = weightedVertexCount(att);
  if (count === null || !weightOrderConflicts(att)) return null;
  const v = att.vertices!, out: number[] = [], order: number[] = [];
  let pair = 0;
  for (let i = 0, k = 0; k < count; k++) {
    const n = v[i++]!;
    const entries = Array.from({ length: n }, (_, j) => ({ pair: pair + j, data: v.slice(i + j * 4, i + j * 4 + 4) }));
    entries.sort((a, b) => a.data[0]! - b.data[0]!);
    out.push(n);
    for (const e of entries) { out.push(...e.data); order.push(e.pair); }
    i += n * 4;
    pair += n;
  }
  att.vertices = out;
  return order;
}

function permuteDeform(key: Key, order: number[]) {
  const values = key.vertices as number[] | undefined;
  if (!values?.length) return;
  const offset = (key.offset as number | undefined) ?? 0;
  const full = new Array<number>(order.length * 2).fill(0);
  values.forEach((x, i) => { if (offset + i < full.length) full[offset + i] = x; });
  const moved = order.flatMap((from) => [full[from * 2]!, full[from * 2 + 1]!]);
  let start = 0, end = moved.length;
  while (start < end && moved[start] === 0) start++;
  while (end > start && moved[end - 1] === 0) end--;
  if (start === end) { delete key.vertices; delete key.offset; return; }
  key.vertices = moved.slice(start, end);
  if (start) key.offset = start; else delete key.offset;
}

export function sortWeightedBones(doc: SkeletonJson): WeightOrder {
  const report = weightOrderReport(doc);
  if (!report.vertices) return report;
  eachMesh(doc, (skin, slot, name, att) => {
    const order = sortAttachmentWeights(att);
    if (!order) return;
    for (const anim of Object.values(doc.animations ?? {})) {
      const deform = anim.attachments?.[skin]?.[slot]?.[name]?.deform;
      for (const key of deform ?? []) permuteDeform(key, order);
    }
  });
  return report;
}

export function stretchedRegions(doc: SkeletonJson, images: ImageLookup): StretchedRegion[] {
  const out: StretchedRegion[] = [];
  eachMesh(doc, (skin, slot, name, att) => {
    if ((att.type ?? "region") !== "region" || att.sequence || att.width === undefined || att.height === undefined) return;
    const image = att.path ?? (att.name as string | undefined) ?? name;
    const img = images(image);
    if (!img) return;
    if (Math.abs(att.width - img.width) > 0.5 || Math.abs(att.height - img.height) > 0.5) {
      out.push({ id: `${skin}/${slot}/${name}`, image, size: [att.width, att.height], file: [img.width, img.height] });
    }
  });
  return out;
}

export function rescaleStretchedRegions(doc: SkeletonJson, images: ImageLookup): StretchedRegion[] {
  const found = stretchedRegions(doc, images);
  const ids = new Set(found.map((f) => f.id));
  const exact = (v: number) => +v.toFixed(4);
  eachMesh(doc, (skin, slot, name, att) => {
    if (!ids.has(`${skin}/${slot}/${name}`)) return;
    const img = images(att.path ?? (att.name as string | undefined) ?? name)!;
    att.scaleX = exact(((att.scaleX as number | undefined) ?? 1) * att.width! / img.width);
    att.scaleY = exact(((att.scaleY as number | undefined) ?? 1) * att.height! / img.height);
    att.width = img.width;
    att.height = img.height;
  });
  return found;
}

export function prepareForImport(doc: SkeletonJson, images?: ImageLookup): string[] {
  const notes: string[] = [];
  const order = sortWeightedBones(doc);
  if (order.vertices) notes.push(`Sorted the weighted vertices of ${order.meshes.length} mesh(es) by bone index, where ${order.vertices} vertices listed the same bones in different orders (${order.meshes.slice(0, 4).join(", ")}${order.meshes.length > 4 ? ", ..." : ""}): Spine's import fails on mixed orders; the pose is unchanged.`);
  if (images) {
    const stretched = rescaleStretchedRegions(doc, images);
    if (stretched.length) notes.push(`Moved the stretch of ${stretched.length} region(s) drawn at another size than their image into scaleX/scaleY (${stretched.slice(0, 4).map((s) => `${s.image} ${s.size.join("x")} over ${s.file.join("x")}`).join(", ")}${stretched.length > 4 ? ", ..." : ""}): Spine writes the image's size back on every export, so the region would shrink.`);
  }
  return notes;
}
