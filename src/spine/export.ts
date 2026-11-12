import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type { Config } from "../config.js";
import { cliFailed, type SpineCli } from "./cli.js";
import { assertInputPath, loadProject, pruneDir, UserError } from "./project.js";
import { loadSkeletonData, spine } from "./runtime.js";
import type { SkeletonJson } from "./types.js";
import { projectEditorVersion } from "./write.js";
import { removeQuiet } from "../platform.js";

export interface ExportOptions {
  project: string;
  /** Absolute folder for the runtime files. Created if missing. */
  outputDir: string;
  format?: "json" | "binary" | "both";
  /** Pack a texture atlas from the project's images folder (default true). */
  atlas?: boolean;
  atlasName?: string;
  /** Atlas scales, e.g. [1, 0.5]; scale 1 has no suffix, others get "@<scale>x". */
  scales?: number[];
  maxSize?: number;
  premultipliedAlpha?: boolean;
  nonessential?: boolean;
  prettyPrint?: boolean;
  /**
   * Editor version that writes the data (default: the pinned one). The data format follows the editor's major.minor
   * and must match the game's runtime: "project" uses the version the project was last saved with, or give one
   * ("4.2.43"). The Spine launcher downloads a version it does not have yet.
   */
  editorVersion?: string;
  /** Images folder; default: the skeleton's `images` path resolved against the project folder. */
  imagesDir?: string;
  /**
   * Defaults for a target (explicit options win): mobile = binary, 2048 pages, premultiplied alpha; desktop = binary,
   * 4096 pages, premultiplied alpha; web = JSON, 2048 pages, premultiplied alpha.
   */
  preset?: "mobile" | "desktop" | "web";
  /** One atlas per skin (`<atlas>-<skin>`, each with the default skin's images too) instead of one for all: a game loads only the skin it shows. */
  atlasPerSkin?: boolean;
  /**
   * Page width and height divisible by 4 (Spine's "Divisible by 4", default true). Unity compresses ETC2, ETC and
   * BC/DXT only in whole 4x4 blocks: any other size falls back to uncompressed RGBA32 on the device (4x the memory).
   */
  multipleOfFour?: boolean;
  /** Run Spine's animation clean up on the exported data (the project itself is not saved). */
  clean?: boolean;
  /** Packer settings: power-of-two pages (default false), polygon or rectangle packing (default polygons), padding in px (default 2). */
  pot?: boolean;
  packing?: "polygons" | "rectangles";
  padding?: number;
  overwrite?: boolean;
}

export interface ExportedFile {
  name: string;
  bytes: number;
}

export interface ExportVerification {
  file: string;
  ok: boolean;
  detail: string;
}

export interface ExportResult {
  outputDir: string;
  files: ExportedFile[];
  verification: ExportVerification[];
  cli: { seconds: number; warnings: string[] };
  /** The editor version that wrote the data (its major.minor is the data format). */
  editorVersion?: string;
  /** Per atlas: pages, how full they are, texture memory (RGBA8, no mip maps). */
  atlases?: AtlasStats[];
  notes?: string[];
}

export interface AtlasStats { file: string; pages: { name: string; width: number; height: number }[]; regions: number; rotated: number; fill: number; memoryMB: number }

export const PRESETS: Record<NonNullable<ExportOptions["preset"]>, Partial<ExportOptions>> = {
  mobile: { format: "binary", maxSize: 2048, premultipliedAlpha: true },
  desktop: { format: "binary", maxSize: 4096, premultipliedAlpha: true },
  web: { format: "json", maxSize: 2048, premultipliedAlpha: true },
};

/** Page sizes, fill (region area over page area) and memory of each packed atlas. */
export function atlasStats(dir: string, names: string[]): AtlasStats[] {
  return names.filter((n) => n.endsWith(".atlas")).map((f) => {
    const atlas = new spine.TextureAtlas(readFileSync(join(dir, f), "utf8"));
    const pages = atlas.pages.map((p) => ({ name: p.name, width: p.width, height: p.height }));
    const area = pages.reduce((a, p) => a + p.width * p.height, 0) || 1;
    const used = atlas.regions.reduce((a, r) => a + r.width * r.height, 0);
    return { file: f, pages, regions: atlas.regions.length, rotated: atlas.regions.filter((r) => r.degrees).length, fill: +(used / area).toFixed(3), memoryMB: +((area * 4) / (1024 * 1024)).toFixed(2) };
  });
}

/** Image names (no extension) the given skins use, sequences expanded. */
export function imagesOfSkins(doc: SkeletonJson, skins: string[]): Set<string> {
  const out = new Set<string>();
  for (const skin of doc.skins ?? []) {
    if (!skins.includes(skin.name)) continue;
    for (const atts of Object.values(skin.attachments ?? {})) for (const [k, a0] of Object.entries(atts as Record<string, Record<string, unknown>>)) {
      const a = a0 as { type?: string; path?: string; name?: string; sequence?: { count?: number; start?: number; digits?: number } };
      if (a.type && !["region", "mesh", "linkedmesh"].includes(a.type)) continue;
      const base = a.path ?? a.name ?? k;
      if (a.sequence?.count) for (let i = 0; i < a.sequence.count; i++) out.add(base + String((a.sequence.start ?? 1) + i).padStart(a.sequence.digits ?? 0, "0"));
      else out.add(base);
    }
  }
  return out;
}

/** Texture packer settings (Spine's packer); only the fields this tool varies are parameters. */
export function packSettings(o: ExportOptions) {
  const scales = o.scales?.length ? o.scales : [1];
  const multipleOfFour = o.multipleOfFour ?? true;
  // Spine's packer refuses a max size not divisible by 4 with multipleOfFour on: round it down (G119).
  const max = multipleOfFour ? Math.floor((o.maxSize ?? 2048) / 4) * 4 : o.maxSize ?? 2048;
  return {
    pot: o.pot ?? false, multipleOfFour, paddingX: o.padding ?? 2, paddingY: o.padding ?? 2, edgePadding: true, duplicatePadding: false, rotation: true,
    minWidth: 16, minHeight: 16, maxWidth: max, maxHeight: max, square: false,
    stripWhitespaceX: true, stripWhitespaceY: true, alphaThreshold: 3, filterMin: "Linear", filterMag: "Linear",
    wrapX: "ClampToEdge", wrapY: "ClampToEdge", format: "RGBA8888", alias: true, outputFormat: "png", jpegQuality: 0.9,
    ignoreBlankImages: true, fast: false, debug: false, silent: false, combineSubdirectories: false, flattenPaths: false,
    premultiplyAlpha: o.premultipliedAlpha ?? false, useIndexes: false, bleed: true, limitMemory: true, packing: o.packing ?? "polygons",
    scale: scales, scaleSuffix: scales.map((s) => (s === 1 ? "" : `@${s}x`)), scaleResampling: scales.map(() => "bicubic"),
    atlasExtension: ".atlas", prettyPrint: true,
  };
}

/**
 * Exports runtime files (skeleton JSON and/or binary, plus a packed atlas) through the Spine CLI into a temp folder,
 * verifies them with spine-core (each skeleton must load with the real atlas), then copies them to `outputDir`.
 * Existing files are not replaced unless `overwrite` is set. The project file is never modified.
 */
export async function exportRuntime(config: Config, cli: SpineCli, input: ExportOptions): Promise<ExportResult> {
  // Preset defaults under the explicit options.
  const o: ExportOptions = { ...(input.preset ? PRESETS[input.preset] : {}), ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as ExportOptions;
  assertInputPath(o.project, [".spine"]);
  if (!isAbsolute(o.outputDir)) throw new UserError(`outputDir must be absolute: ${o.outputDir}`);
  const format = o.format ?? "json";
  const withAtlas = o.atlas ?? true;
  const scales = o.scales?.length ? o.scales : [1];
  if (scales.some((s) => !(s > 0 && s <= 4))) throw new UserError("scales must be within (0, 4]");
  const loaded = await loadProject(config, cli, o.project);
  const atlasName = o.atlasName ?? basename(o.project, ".spine");
  let imagesDir = o.imagesDir;
  if (imagesDir && !isAbsolute(imagesDir)) throw new UserError(`imagesDir must be an absolute path: ${imagesDir}`);
  if (withAtlas && !imagesDir) {
    const rel = loaded.skeletons[0]!.doc.skeleton.images;
    if (!rel) throw new UserError("The skeleton has no images path; pass imagesDir.");
    imagesDir = resolve(dirname(o.project), rel);
  }
  if (withAtlas && (!imagesDir || !existsSync(imagesDir))) throw new UserError(`Images folder not found: ${imagesDir} (pass imagesDir)`);

  const root = join(config.workDir, "export-out");
  pruneDir(root, 20);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const settingsDir = join(root, `${stamp}-settings`), tmp = join(root, `${stamp}-files`);
  mkdirSync(settingsDir, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const args: string[] = [];
  const clean = o.clean ? ["-m"] : [];
  if (format === "json" || format === "both") {
    const f = join(settingsDir, "json.json");
    writeFileSync(f, JSON.stringify({ class: "json", extension: ".json", format: "JSON", nonessential: o.nonessential ?? false, prettyPrint: o.prettyPrint ?? false }));
    args.push("-i", o.project, ...clean, "-o", tmp, "-e", f);
  }
  if (format === "binary" || format === "both") {
    const f = join(settingsDir, "binary.json");
    writeFileSync(f, JSON.stringify({ class: "binary", extension: ".skel", nonessential: o.nonessential ?? false }));
    args.push("-i", o.project, ...clean, "-o", tmp, "-e", f);
  }
  const skinAtlases: { skin: string; name: string; images: Set<string> }[] = [];
  if (withAtlas) {
    const f = join(settingsDir, "pack.json");
    writeFileSync(f, JSON.stringify(packSettings({ ...o, scales })));
    if (o.atlasPerSkin) {
      // A folder per skin with the default skin's images and its own, packed on its own.
      const doc = loaded.skeletons[0]!.doc;
      const skins = (doc.skins ?? []).map((sk) => sk.name).filter((n) => n !== "default");
      if (!skins.length) throw new UserError("atlasPerSkin needs skins besides the default one");
      for (const skin of skins) {
        const images = imagesOfSkins(doc, ["default", skin]);
        const dir = join(settingsDir, `skin-${skin.replace(/[^\w.-]+/g, "_")}`);
        for (const img of images) {
          const src = ["png", "jpg", "jpeg"].map((e) => join(imagesDir!, `${img}.${e}`)).find(existsSync);
          if (!src) continue;
          const dst = join(dir, `${img}${extname(src)}`);
          mkdirSync(dirname(dst), { recursive: true });
          copyFileSync(src, dst);
        }
        const name = `${atlasName}-${skin.replace(/[^\w.-]+/g, "_")}`;
        skinAtlases.push({ skin, name, images });
        args.push("-i", dir, "-o", tmp, "-n", name, "-j", o.project, "-p", f);
      }
    } else {
      // -j: let the packer see which images meshes use (mesh-aware whitespace stripping).
      args.push("-i", imagesDir!, "-o", tmp, "-n", atlasName, "-j", o.project, "-p", f);
    }
  }
  // Which editor writes the data: its major.minor is the data format the runtime must read.
  const pinned = config.spineVersion;
  let editor = o.editorVersion === "project" ? (await projectEditorVersion(cli, o.project)) ?? pinned : o.editorVersion ?? pinned;
  if (o.editorVersion && o.editorVersion !== "project" && !/^\d+\.\d+\.\d+$/.test(o.editorVersion)) throw new UserError(`editorVersion must be "project" or a full version like 4.2.43: ${o.editorVersion}`);
  editor = editor.trim();
  const minor = (v: string) => v.split(".").slice(0, 2).join(".");
  const foreign = !!editor && !!pinned && minor(editor) !== minor(pinned);
  const notes: string[] = [];
  if (withAtlas && (o.multipleOfFour ?? true) && o.maxSize && o.maxSize % 4) notes.push(`maxSize ${o.maxSize} rounded down to ${packSettings(o).maxWidth}: pages are packed divisible by 4 (ETC2 and DXT need it), and Spine's packer then needs a max size divisible by 4.`);
  if (!o.editorVersion) {
    const saved = await projectEditorVersion(cli, o.project).catch(() => null);
    if (saved && pinned && minor(saved) !== minor(pinned)) notes.push(`The project was saved with Spine ${saved}; this export is Spine ${minor(pinned)} data. If the game's runtime is ${minor(saved)}, export with editorVersion: "project".`);
  }
  const run = await cli.run(args, { version: editor });
  const discard = () => removeQuiet(tmp);
  if (cliFailed(run)) {
    discard();
    throw new UserError(`Spine export failed (exit ${run.exitCode}): ${[...run.errors, ...run.lines.slice(-3)].join(" | ")}`);
  }
  const names = readdirSync(tmp).sort();
  if (!names.length) {
    discard();
    throw new UserError("Spine export produced no files");
  }

  // spine-core 4.3 reads only 4.3 data: older data is checked by its version header.
  const verification = foreign ? verifyHeaders(tmp, names, editor)
    : skinAtlases.length ? [...verifyExport(tmp, names, atlasName, scales, false), ...verifySkinAtlases(tmp, names, skinAtlases)]
    : verifyExport(tmp, names, atlasName, scales, withAtlas);
  if (foreign) notes.push(`Exported as Spine ${editor} data for a ${minor(editor)} runtime. spine-core ${minor(pinned)} cannot read it, so the check is each file's version header; the other spine-mcp tools keep working on the project with ${pinned}.`);
  const failed = verification.filter((v) => !v.ok);
  if (failed.length) {
    discard();
    throw new UserError(`Export did not verify, nothing was copied: ${failed.map((v) => `${v.file}: ${v.detail}`).join(" | ")}`);
  }
  mkdirSync(o.outputDir, { recursive: true });
  const conflicts = names.filter((n) => existsSync(join(o.outputDir, n)));
  if (conflicts.length && !o.overwrite) {
    discard();
    throw new UserError(`These files already exist in ${o.outputDir}: ${conflicts.join(", ")}. Pass overwrite: true to replace them.`);
  }
  const files = names.map((n) => {
    copyFileSync(join(tmp, n), join(o.outputDir, n));
    return { name: n, bytes: statSync(join(o.outputDir, n)).size };
  });
  const atlases = withAtlas ? atlasStats(tmp, names) : [];
  discard();
  for (const a of atlases) {
    if (a.fill < 0.5) notes.push(`${a.file}: pages are ${Math.round(a.fill * 100)}% full (${a.pages.map((p) => `${p.width}x${p.height}`).join(", ")}); a smaller maxSize or fewer scales wastes less texture memory.`);
    if (o.preset === "mobile" && a.pages.some((p) => Math.max(p.width, p.height) > 2048)) notes.push(`${a.file}: pages over 2048 px; some older mobile GPUs cap textures at 2048.`);
    const odd = a.pages.filter((p) => p.width % 4 || p.height % 4);
    if (odd.length) notes.push(`${a.file}: ${odd.map((p) => `${p.width}x${p.height}`).join(", ")} not divisible by 4: Unity cannot compress such a page to ETC2 or BC/DXT and ships it as RGBA32 (4x the memory). Pack with "Divisible by 4", or use ASTC.`);
  }
  if (atlases.length) notes.push(`Atlas memory (RGBA8, no mip maps): ${atlases.map((a) => `${a.file} ${a.memoryMB} MB in ${a.pages.length} page(s)`).join(", ")}.`);
  if (skinAtlases.length) notes.push(`One atlas per skin (${skinAtlases.map((s) => s.name).join(", ")}), each with the default skin's images: load the skeleton with the atlas of the skin it shows.`);
  return { outputDir: o.outputDir, files, verification, cli: { seconds: run.seconds, warnings: run.warnings }, editorVersion: editor, atlases, ...(notes.length ? { notes } : {}) };
}

/** Each skin's atlas holds a region for every image the default skin and that skin use. */
function verifySkinAtlases(dir: string, names: string[], skins: { skin: string; name: string; images: Set<string> }[]): ExportVerification[] {
  return skins.map((s) => {
    const f = `${s.name}.atlas`;
    if (!names.includes(f)) return { file: f, ok: false, detail: "atlas not produced" };
    const atlas = new spine.TextureAtlas(readFileSync(join(dir, f), "utf8"));
    const have = new Set(atlas.regions.map((r) => r.name));
    const missing = [...s.images].filter((i) => !have.has(i));
    const pagesMissing = atlas.pages.filter((p) => !names.includes(p.name)).map((p) => p.name);
    return { file: f, ok: !missing.length && !pagesMissing.length, detail: missing.length ? `missing regions ${missing.slice(0, 5).join(", ")}` : pagesMissing.length ? `missing pages ${pagesMissing.join(", ")}` : `${atlas.regions.length} regions for skin ${s.skin} + default` };
  });
}

/** Skeleton files written by another editor version: the version they carry must be the one asked for. */
export function verifyHeaders(dir: string, names: string[], version: string): ExportVerification[] {
  return names.filter((n) => n.endsWith(".json") || n.endsWith(".skel")).map((f) => {
    const buf = readFileSync(join(dir, f));
    let found: string | null = null;
    if (f.endsWith(".json")) { try { found = (JSON.parse(buf.toString("utf8")) as { skeleton?: { spine?: string } }).skeleton?.spine ?? null; } catch { found = null; } }
    else found = /\d+\.\d+\.\d+/.exec(buf.subarray(0, 64).toString("latin1"))?.[0] ?? null;
    const ok = !!found && found.split(".").slice(0, 2).join(".") === version.split(".").slice(0, 2).join(".");
    return { file: f, ok, detail: ok ? `Spine ${found} data` : `version header ${found ?? "missing"}, expected ${version}` };
  });
}

function verifyExport(dir: string, names: string[], atlasName: string, scales: number[], withAtlas: boolean): ExportVerification[] {
  const out: ExportVerification[] = [];
  const atlasFile = (s: number) => `${atlasName}${s === 1 ? "" : `@${s}x`}.atlas`;
  let base: spine.TextureAtlas | null = null;
  if (withAtlas) {
    for (const s of scales) {
      const f = atlasFile(s);
      if (!names.includes(f)) {
        out.push({ file: f, ok: false, detail: "atlas not produced" });
        continue;
      }
      try {
        const atlas = new spine.TextureAtlas(readFileSync(join(dir, f), "utf8"));
        const missingPages = atlas.pages.filter((p) => !names.includes(p.name)).map((p) => p.name);
        base ??= atlas;
        const sameRegions = atlas.regions.length === base.regions.length;
        out.push({
          file: f, ok: !missingPages.length && sameRegions,
          detail: missingPages.length ? `missing pages ${missingPages.join(", ")}` : `${atlas.pages.length} page(s), ${atlas.regions.length} regions${sameRegions ? "" : " (differs from scale 1)"}`,
        });
      } catch (e) {
        out.push({ file: f, ok: false, detail: (e as Error).message });
      }
    }
  }
  for (const f of names.filter((n) => n.endsWith(".json") || n.endsWith(".skel"))) {
    try {
      const data = f.endsWith(".skel")
        ? new spine.SkeletonBinary(base ? new spine.AtlasAttachmentLoader(base) : noAtlas()).readSkeletonData(new Uint8Array(readFileSync(join(dir, f))))
        : base
          ? new spine.SkeletonJson(new spine.AtlasAttachmentLoader(base)).readSkeletonData(readFileSync(join(dir, f), "utf8"))
          : loadSkeletonData(JSON.parse(readFileSync(join(dir, f), "utf8")));
      out.push({ file: f, ok: true, detail: `loads in spine-core${base ? " with the atlas" : ""}: ${data.bones.length} bones, ${data.animations.length} animations` });
    } catch (e) {
      out.push({ file: f, ok: false, detail: (e as Error).message });
    }
  }
  return out;
}

/** Structure-only loader for binary verification without an atlas. */
function noAtlas(): spine.AttachmentLoader {
  const fill = (seq: spine.Sequence) => {
    for (let i = 0; i < seq.regions.length; i++) seq.regions[i] = Object.assign(new spine.TextureRegion(), { u: 0, v: 0, u2: 1, v2: 1, width: 1, height: 1, originalWidth: 1, originalHeight: 1 });
  };
  return {
    newRegionAttachment: (_s, _p, name, _path, seq) => (fill(seq), new spine.RegionAttachment(name, seq)),
    newMeshAttachment: (_s, _p, name, _path, seq) => (fill(seq), new spine.MeshAttachment(name, seq)),
    newBoundingBoxAttachment: (_s, _p, name) => new spine.BoundingBoxAttachment(name),
    newPathAttachment: (_s, _p, name) => new spine.PathAttachment(name),
    newPointAttachment: (_s, _p, name) => new spine.PointAttachment(name),
    newClippingAttachment: (_s, _p, name) => new spine.ClippingAttachment(name),
  };
}

/** Bits per pixel of the texture formats spine-mcp reports (ASTC: 128 bits per block). */
export const TEXTURE_BITS = { rgba32: 32, etc2: 8, astc4x4: 8, astc5x5: 128 / 25, astc6x6: 128 / 36, astc8x8: 2, astc10x10: 1.28, astc12x12: 128 / 144 } as const;
export type TextureFormatName = keyof typeof TEXTURE_BITS;

/** Megabytes of a page area in a texture format (no mip maps; mip maps add a third). */
export const formatMB = (area: number, format: TextureFormatName) => +((area * TEXTURE_BITS[format]) / 8 / (1024 * 1024)).toFixed(2);

/** Texture memory of a page area in a few formats (no mip maps; mip maps add a third). */
export function textureMemory(area: number): { rgba32MB: number; etc2MB: number; astc6x6MB: number } {
  return { rgba32MB: formatMB(area, "rgba32"), etc2MB: formatMB(area, "etc2"), astc6x6MB: formatMB(area, "astc6x6") };
}

export interface PackSweepRow {
  settings: { maxSize: number; pot: boolean; packing: "polygons" | "rectangles"; padding: number };
  pages: number;
  sizes: string[];
  fill: number;
  rgba32MB: number;
  etc2MB: number;
  astc6x6MB: number;
}

/**
 * Packs the project's atlas with every combination of the given settings (Spine CLI, temp folders, nothing kept) and
 * ranks them by texture memory, then page count: the cheapest settings that still fit.
 */
export async function packSweep(config: Config, cli: SpineCli, o: Omit<ExportOptions, "outputDir"> & { sweep: { maxSize?: number[]; pot?: boolean[]; packing?: ("polygons" | "rectangles")[]; padding?: number[] } }): Promise<{ rows: PackSweepRow[]; notes: string[] }> {
  const sizes = o.sweep.maxSize?.length ? o.sweep.maxSize : [1024, 2048, 4096];
  const pots = o.sweep.pot?.length ? o.sweep.pot : [false, true];
  const packings = o.sweep.packing?.length ? o.sweep.packing : ["polygons" as const];
  const paddings = o.sweep.padding?.length ? o.sweep.padding : [2];
  const combos = sizes.flatMap((maxSize) => pots.flatMap((pot) => packings.flatMap((packing) => paddings.map((padding) => ({ maxSize, pot, packing, padding })))));
  if (combos.length > 24) throw new UserError(`${combos.length} combinations; keep a sweep to 24 or fewer (about 3 s each)`);
  const rows: PackSweepRow[] = [];
  for (const c of combos) {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-sweep-"));
    try {
      const { sweep: _s, ...rest } = o;
      const r = await exportRuntime(config, cli, { ...rest, outputDir: dir, format: "json", ...c, scales: [1], overwrite: true });
      const a = r.atlases ?? [];
      const pages = a.flatMap((x) => x.pages), area = pages.reduce((s2, p) => s2 + p.width * p.height, 0);
      const used = a.reduce((s2, x) => s2 + x.fill * x.pages.reduce((t, p) => t + p.width * p.height, 0), 0);
      rows.push({ settings: c, pages: pages.length, sizes: pages.map((p) => `${p.width}x${p.height}`), fill: +(used / (area || 1)).toFixed(3), ...textureMemory(area) });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  rows.sort((x, y) => x.rgba32MB - y.rgba32MB || x.pages - y.pages);
  const notes = [
    `${rows.length} packing(s), cheapest texture memory first (RGBA32; ETC2 RGBA8 and ASTC 6x6 for compressed mobile textures; mip maps add a third). Fewer pages also mean fewer draw calls.`,
    "Power-of-two pages matter for older GPUs and some compression formats (PVRTC needs square POT); ASTC and ETC2 do not need them. ETC2 and BC/DXT need sides divisible by 4 in Unity (always packed so), ASTC does not.",
  ];
  return { rows, notes };
}
