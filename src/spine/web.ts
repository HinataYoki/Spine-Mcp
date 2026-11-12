import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import type { Config } from "../config.js";
import type { SpineCli } from "./cli.js";
import { exportRuntime } from "./export.js";
import { UserError } from "./project.js";
import { renderFrames } from "./render.js";
import { compareFrames } from "./visual.js";
import { removeQuiet, renderFolder } from "../platform.js";
import { launchChrome, SPINE_WEBGL } from "./chrome.js";

const require = createRequire(import.meta.url);
const GREY = 127;
// Same calibration as the Unity visual check.
const MEAN_IOU = 0.93, MIN_IOU = 0.9, COLOR = 0.07;

export interface WebCheckOptions {
  project: string;
  animations?: string[];
  fps?: number;
  scale?: number;
}

export interface WebVisual {
  animation: string;
  frames: number;
  minIoU: number;
  meanIoU: number;
  meanColorDiff: number;
  worstFrame: number;
  ok: boolean;
}

export interface WebCheckResult {
  runtime: string;
  browser: string;
  visual: WebVisual[];
  ok: boolean;
  errors: string[];
  seconds: number;
  notes: string[];
  visualPng?: Buffer;
}

/** The page: spine-webgl renders each frame (sequential playback, physics stepped) and hands back PNG data URLs. */
const PAGE = `<!doctype html><html><body style="margin:0;background:#7f7f7f"><canvas id="c"></canvas></body></html>`;

function renderInPage(args: { atlas: string; json: string; pages: Record<string, string>; animations: string[] | null; fps: number; scale: number; grey: number }) {
  // Runs in the browser with the spine-webgl IIFE loaded (global `spine`).
  const spine = (globalThis as unknown as { spine: any }).spine;
  return new Promise<Record<string, string[]>>((resolve, reject) => {
    try {
      const canvas = document.getElementById("c") as HTMLCanvasElement;
      const ctx = new spine.ManagedWebGLRenderingContext(canvas, { alpha: false, preserveDrawingBuffer: true, antialias: true });
      const gl = ctx.gl as WebGLRenderingContext;
      const renderer = new spine.SceneRenderer(canvas, ctx, true);
      renderer.skeletonRenderer.premultipliedAlpha = true;
      const atlas = new spine.TextureAtlas(args.atlas);
      let pending = atlas.pages.length;
      for (const page of atlas.pages) {
        const img = new Image();
        img.onload = () => {
          page.setTexture(new spine.GLTexture(ctx, img, true));
          if (--pending === 0) go();
        };
        img.onerror = () => reject(new Error(`texture ${page.name} failed to load`));
        img.src = args.pages[page.name]!;
      }
      const go = () => {
        const data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(args.json);
        const out: Record<string, string[]> = {};
        const names = args.animations ?? data.animations.filter((a: any) => a.duration > 0).map((a: any) => a.name);
        for (const name of names) {
          const anim = data.findAnimation(name);
          if (!anim) continue;
          const sk = new spine.Skeleton(data);
          const frames = Math.max(1, Math.round(anim.duration * args.fps));
          const pose = (k: number) => {
            if (k > 0) sk.update(1 / args.fps);
            sk.setupPose();
            // Key times are float32: a double frame time lands just before a key on an exact frame (Spine uses float).
            const t = Math.fround(k / args.fps);
            anim.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
            sk.updateWorldTransform(k === 0 ? spine.Physics.reset : spine.Physics.update);
          };
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          const offset = new spine.Vector2(), size = new spine.Vector2();
          for (let k = 0; k < frames; k++) {
            pose(k);
            sk.getBounds(offset, size, []);
            minX = Math.min(minX, offset.x); minY = Math.min(minY, offset.y);
            maxX = Math.max(maxX, offset.x + size.x); maxY = Math.max(maxY, offset.y + size.y);
          }
          const s = args.scale / 100;
          const w = Math.max(8, Math.ceil((maxX - minX) * s)), h = Math.max(8, Math.ceil((maxY - minY) * s));
          canvas.width = w; canvas.height = h;
          gl.viewport(0, 0, w, h);
          renderer.camera.setViewport(maxX - minX, maxY - minY);
          renderer.camera.position.x = (minX + maxX) / 2;
          renderer.camera.position.y = (minY + maxY) / 2;
          renderer.camera.update();
          const shots: string[] = [];
          for (let k = 0; k < frames; k++) {
            pose(k);
            gl.clearColor(args.grey, args.grey, args.grey, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            renderer.begin();
            renderer.drawSkeleton(sk); // PMA is set on renderer.skeletonRenderer; the 2nd parameter is a slot range
            renderer.end();
            shots.push(canvas.toDataURL("image/png"));
          }
          out[name] = shots;
        }
        resolve(out);
      };
      if (pending === 0) go();
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Renders animations with Esoteric's spine-webgl (the renderer behind spine-player and the base of web integrations)
 * in headless Chrome and compares every frame with Spine's own render.
 */
export async function webCheck(config: Config, cli: SpineCli, o: WebCheckOptions): Promise<WebCheckResult> {
  const t0 = Date.now();
  const fps = o.fps ?? 10, scale = o.scale ?? 50;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const work = join(config.workDir, "web", stamp);
  mkdirSync(work, { recursive: true });
  const notes: string[] = [];
  try {
    const ex = await exportRuntime(config, cli, { project: o.project, outputDir: join(work, "export"), format: "json", premultipliedAlpha: true });
    const file = (ext: string) => join(work, "export", ex.files.find((f) => f.name.endsWith(ext) && !f.name.includes("@"))!.name);
    const atlasText = readFileSync(file(".atlas"), "utf8");
    const pages: Record<string, string> = {};
    for (const f of ex.files.filter((x) => x.name.endsWith(".png") && !x.name.includes("@"))) pages[f.name] = `data:image/png;base64,${readFileSync(join(work, "export", f.name)).toString("base64")}`;
    const bundle = SPINE_WEBGL;
    const runtime = JSON.parse(readFileSync(require.resolve("@esotericsoftware/spine-webgl/package.json"), "utf8")).version as string;
    const browser = await launchChrome("spine_web_check");
    const errors: string[] = [];
    let shots: Record<string, string[]>;
    let version = "";
    try {
      const page = await browser.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      await page.setContent(PAGE);
      await page.addScriptTag({ path: bundle });
      shots = await page.evaluate(renderInPage, { atlas: atlasText, json: readFileSync(file(".json"), "utf8"), pages, animations: o.animations?.length ? o.animations : null, fps, scale, grey: GREY / 255 });
      version = browser.version();
    } finally {
      await browser.close();
    }
    const skeletonName = basename(file(".json"), ".json");
    const visual: WebVisual[] = [];
    let worst: { score: number; png: () => Buffer } | null = null;
    for (const [name, frames] of Object.entries(shots)) {
      const dir = join(work, "web", renderFolder(name));
      mkdirSync(dir, { recursive: true });
      const webFrames = frames.map((d, k) => {
        const p = join(dir, `frame_${String(k).padStart(3, "0")}.png`);
        writeFileSync(p, Buffer.from(d.split(",")[1]!, "base64"));
        return p;
      });
      const ref = await renderFrames(config, cli, o.project, { skeleton: skeletonName, animation: name, fps, scale, background: "7f7f7fff" });
      const n = Math.min(webFrames.length, ref.frames.length);
      let minIoU = 1, sumIoU = 0, sumColor = 0, worstFrame = 0;
      for (let k = 0; k < n; k++) {
        const c = compareFrames(ref.frames[k]!, webFrames[k]!, [GREY, GREY, GREY]);
        sumIoU += c.iou; sumColor += c.colorDiff;
        if (c.iou < minIoU) { minIoU = c.iou; worstFrame = k; }
        const score = 1 - c.iou + c.colorDiff;
        if (!worst || score > worst.score) worst = { score, png: c.diffPng };
      }
      const meanIoU = sumIoU / Math.max(1, n), meanColor = sumColor / Math.max(1, n);
      visual.push({ animation: name, frames: n, minIoU: +minIoU.toFixed(4), meanIoU: +meanIoU.toFixed(4), meanColorDiff: +meanColor.toFixed(4), worstFrame, ok: meanIoU >= MEAN_IOU && minIoU >= MIN_IOU && meanColor <= COLOR });
    }
    if (atlasText && readFileSync(file(".json"), "utf8").includes('"physics"')) notes.push("This rig has physics: each renderer runs its own simulation, so physics-driven parts can differ. Bake the physics (bakePhysics) for an exact comparison.");
    notes.push(`spine-webgl ${runtime} in headless Chrome vs Spine's own render at ${fps} fps, ${scale}%, premultiplied alpha; ok = mean silhouette IoU >= ${MEAN_IOU}, worst frame >= ${MIN_IOU}, mean colour difference <= ${COLOR}.`);
    return {
      runtime: `spine-webgl ${runtime}`, browser: version, visual, ok: errors.length === 0 && visual.length > 0 && visual.every((v) => v.ok),
      errors, seconds: +((Date.now() - t0) / 1000).toFixed(1), notes, visualPng: worst?.png(),
    };
  } finally {
    removeQuiet(work);
  }
}

export interface SkinSheetOptions {
  project: string;
  skeleton?: string;
  combinations: string[][];
  /** Pose to draw (default: setup pose); with `time` a frame of it. */
  animation?: string;
  time?: number;
  /** Tile size in pixels (default 256). */
  cell?: number;
}

/** In the page: each skin combination drawn at one shared scale into a labelled grid (one PNG data URL). */
function sheetInPage(args: { atlas: string; json: string; pages: Record<string, string>; combos: string[][]; animation: string | null; time: number; cell: number; grey: number }) {
  const spine = (globalThis as unknown as { spine: any }).spine;
  return new Promise<{ png: string; missing: string[] }>((resolve, reject) => {
    try {
      const canvas = document.getElementById("c") as HTMLCanvasElement;
      const ctx = new spine.ManagedWebGLRenderingContext(canvas, { alpha: false, preserveDrawingBuffer: true, antialias: true });
      const gl = ctx.gl as WebGLRenderingContext;
      const renderer = new spine.SceneRenderer(canvas, ctx, true);
      renderer.skeletonRenderer.premultipliedAlpha = true;
      const atlas = new spine.TextureAtlas(args.atlas);
      let pending = atlas.pages.length;
      const go = () => {
        const data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(args.json);
        const missing: string[] = [];
        const anim = args.animation ? data.findAnimation(args.animation) : null;
        const pose = (names: string[]) => {
          const sk = new spine.Skeleton(data);
          const skin = new spine.Skin(names.join("+"));
          for (const n of names) { const s = data.findSkin(n); if (s) skin.addSkin(s); else missing.push(n); }
          sk.setSkin(skin);
          sk.setupPoseSlots();
          sk.setupPose();
          if (anim) anim.apply(sk, args.time, args.time, false, null, 1, spine.MixFrom.setup, false, false, false);
          sk.updateWorldTransform(spine.Physics.reset);
          return sk;
        };
        // One scale for every tile so sizes compare.
        const offset = new spine.Vector2(), size = new spine.Vector2();
        const bounds = args.combos.map((c) => { pose(c).getBounds(offset, size, []); return { x: offset.x, y: offset.y, w: size.x, h: size.y }; });
        const maxW = Math.max(1, ...bounds.map((b) => b.w)), maxH = Math.max(1, ...bounds.map((b) => b.h));
        const label = 34, cell = args.cell;
        const scale = Math.min((cell - 16) / maxW, (cell - 16) / maxH);
        canvas.width = cell; canvas.height = cell;
        gl.viewport(0, 0, cell, cell);
        const cols = Math.min(4, args.combos.length), rows = Math.ceil(args.combos.length / cols);
        const sheet = document.createElement("canvas");
        sheet.width = cols * cell; sheet.height = rows * (cell + label);
        const g = sheet.getContext("2d")!;
        g.fillStyle = "#f4f4f8"; g.fillRect(0, 0, sheet.width, sheet.height);
        args.combos.forEach((c, i) => {
          const sk = pose(c), b = bounds[i]!;
          renderer.camera.setViewport(cell / scale, cell / scale);
          renderer.camera.position.x = b.x + b.w / 2;
          renderer.camera.position.y = b.y + b.h / 2;
          renderer.camera.update();
          gl.clearColor(args.grey, args.grey, args.grey, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          renderer.begin();
          renderer.drawSkeleton(sk);
          renderer.end();
          const x = (i % cols) * cell, y = Math.floor(i / cols) * (cell + label);
          g.drawImage(canvas, x, y);
          g.fillStyle = "#1d1f33"; g.font = "12px -apple-system, Helvetica, Arial, sans-serif"; g.textBaseline = "top";
          const text = c.join(" + ");
          const lines = text.length > 40 ? [text.slice(0, 40), text.slice(40, 80) + (text.length > 80 ? "..." : "")] : [text];
          lines.forEach((l, k) => g.fillText(l, x + 6, y + cell + 4 + k * 14));
        });
        resolve({ png: sheet.toDataURL("image/png"), missing });
      };
      for (const page of atlas.pages) {
        const img = new Image();
        img.onload = () => { page.setTexture(new spine.GLTexture(ctx, img, true)); if (--pending === 0) go(); };
        img.onerror = () => reject(new Error(`texture ${page.name} failed to load`));
        img.src = args.pages[page.name]!;
      }
      if (pending === 0) go();
    } catch (e) {
      reject(e);
    }
  });
}

/** Skin combinations rendered side by side with spine-webgl (headless Chrome): what the Spine CLI cannot render. */
export async function skinSheet(config: Config, cli: SpineCli, o: SkinSheetOptions): Promise<{ png: Buffer; notes: string[] }> {
  const work = join(config.workDir, "web", `skins-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(work, { recursive: true });
  try {
    const ex = await exportRuntime(config, cli, { project: o.project, outputDir: join(work, "export"), format: "json", premultipliedAlpha: true });
    const jsons = ex.files.filter((f) => f.name.endsWith(".json"));
    const jsonFile = o.skeleton ? jsons.find((f) => f.name === `${o.skeleton}.json`) : jsons[0];
    if (!jsonFile) throw new UserError(`Skeleton "${o.skeleton}" not found in the export`);
    if (!o.skeleton && jsons.length > 1) throw new UserError(`Project has ${jsons.length} skeletons; pass skeleton`);
    const atlasFile = ex.files.find((f) => f.name.endsWith(".atlas") && !f.name.includes("@"))!;
    const pages: Record<string, string> = {};
    for (const f of ex.files.filter((x) => x.name.endsWith(".png") && !x.name.includes("@"))) pages[f.name] = `data:image/png;base64,${readFileSync(join(work, "export", f.name)).toString("base64")}`;
    const browser = await launchChrome("skin renders");
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.setContent(PAGE);
      await page.addScriptTag({ path: SPINE_WEBGL });
      const r = await page.evaluate(sheetInPage, {
        atlas: readFileSync(join(work, "export", atlasFile.name), "utf8"), json: readFileSync(join(work, "export", jsonFile.name), "utf8"), pages,
        combos: o.combinations, animation: o.animation ?? null, time: Math.fround(o.time ?? 0), cell: o.cell ?? 256, grey: 0.93,
      });
      if (errors.length) throw new UserError(`spine-webgl: ${errors[0]}`);
      if (r.missing.length) throw new UserError(`Skin(s) not found: ${[...new Set(r.missing)].join(", ")}`);
      return { png: Buffer.from(r.png.split(",")[1]!, "base64"), notes: [`Rendered with spine-webgl ${JSON.parse(readFileSync(require.resolve("@esotericsoftware/spine-webgl/package.json"), "utf8")).version} at one shared scale${o.animation ? `, ${o.animation} at ${o.time ?? 0}s` : ", setup pose"}; combinations are built with Skin.addSkin in the order given.`] };
    } finally {
      await browser.close();
    }
  } finally {
    removeQuiet(work);
  }
}
