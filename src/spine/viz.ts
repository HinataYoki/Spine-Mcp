import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Config } from "../config.js";
import type { SpineCli } from "./cli.js";
import { BONE_CHANNELS } from "./curves.js";
import { exportRuntime } from "./export.js";
import { measureMotion } from "./measure.js";
import { loadProject, pickSkeleton, UserError } from "./project.js";
import { loadSkeletonData } from "./runtime.js";
import { sampleAnimation } from "./sample.js";
import { launchChrome, SPINE_WEBGL } from "./chrome.js";
import { removeQuiet } from "../platform.js";

const require = createRequire(import.meta.url);

export type VizMode = "onion" | "arcs" | "graph" | "all";

export interface MotionVisualOptions {
  project: string;
  skeleton?: string;
  animation: string;
  mode?: VizMode;
  /** Bones to trace and plot (default: the 3 that travel furthest). */
  bones?: string[];
  /** Sampling rate (default 30). */
  fps?: number;
  /** Ghost frames in the onion skin (default 8). */
  ghosts?: number;
  /** Panel height in px (default 520). */
  size?: number;
}

export interface MotionVisualResult {
  animation: string;
  mode: VizMode;
  fps: number;
  frames: number;
  bones: string[];
  /** World positions per frame (skeleton units), for reasoning without the picture. */
  arcs: { bone: string; points: [number, number, number][]; pathLength: number; maxStep: number; minStep: number }[];
  /** Local channel values per frame and the key times of each channel. */
  curves: { bone: string; channel: string; values: number[]; keys: number[] }[];
  /** Panel transform: px = (x - cx) * scale + width / 2, py = height / 2 - (y - cy) * scale (arcs and onion panel). */
  projection: { cx: number; cy: number; scale: number; width: number; height: number };
  notes: string[];
  png: Buffer;
}

const PAGE = `<!doctype html><html><body style="margin:0;background:#fff"><canvas id="c"></canvas></body></html>`;
const COLORS = ["#e4572e", "#2e86ab", "#17a398", "#f3a712", "#8e5cd9", "#d81159"];

interface PageArgs {
  atlas: string; json: string; pages: Record<string, string>; animation: string; fps: number; bones: string[];
  channels: { bone: string; channel: string; keys: number[] }[]; mode: VizMode; ghosts: number; size: number; colors: string[];
}

/** In the page: sequential playback (physics stepped, float32 frame times), then onion skin, arcs and curves drawn. */
function vizInPage(a: PageArgs) {
  const spine = (globalThis as unknown as { spine: any }).spine;
  return new Promise<{ png: string; arcs: [number, number, number][][]; values: number[][]; projection: { cx: number; cy: number; scale: number; width: number; height: number } }>((resolve, reject) => {
    try {
      const gl1 = document.getElementById("c") as HTMLCanvasElement;
      const ctx = new spine.ManagedWebGLRenderingContext(gl1, { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: true });
      const gl = ctx.gl as WebGLRenderingContext;
      const renderer = new spine.SceneRenderer(gl1, ctx, true);
      renderer.skeletonRenderer.premultipliedAlpha = true;
      const atlas = new spine.TextureAtlas(a.atlas);
      let pending = atlas.pages.length;
      const go = () => {
        const data = new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas)).readSkeletonData(a.json);
        const anim = data.findAnimation(a.animation);
        const sk = new spine.Skeleton(data);
        const n = Math.max(2, Math.round(anim.duration * a.fps) + 1);
        const pose = (k: number) => {
          if (k > 0) sk.update(1 / a.fps);
          sk.setupPose();
          const t = Math.fround(Math.min(anim.duration, k / a.fps));
          anim.apply(sk, t, t, false, null, 1, spine.MixFrom.setup, false, false, false);
          sk.updateWorldTransform(k === 0 ? spine.Physics.reset : spine.Physics.update);
        };
        const arcs: [number, number, number][][] = a.bones.map(() => []);
        const values: number[][] = a.channels.map(() => []);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const offset = new spine.Vector2(), size = new spine.Vector2();
        for (let k = 0; k < n; k++) {
          pose(k);
          sk.getBounds(offset, size, []);
          minX = Math.min(minX, offset.x); minY = Math.min(minY, offset.y); maxX = Math.max(maxX, offset.x + size.x); maxY = Math.max(maxY, offset.y + size.y);
          a.bones.forEach((name, i) => { const b = sk.findBone(name).appliedPose; arcs[i]!.push([+(k / a.fps).toFixed(4), b.worldX, b.worldY]); });
          a.channels.forEach((c, i) => {
            const p = sk.findBone(c.bone).pose; // the animated local pose, before constraints: what the keys set
            const v = c.channel === "rotate" ? p.rotation : c.channel === "x" ? p.x : c.channel === "y" ? p.y : c.channel === "scaleX" ? p.scaleX : p.scaleY;
            values[i]!.push(v);
          });
        }
        const H = a.size, pad = 24;
        const scale = Math.min((H - pad * 2) / Math.max(1, maxY - minY), (H * 1.2 - pad * 2) / Math.max(1, maxX - minX));
        const W = Math.ceil((maxX - minX) * scale + pad * 2);
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        const panelW = a.mode === "graph" ? 0 : W;
        const graphW = a.mode === "graph" || a.mode === "all" ? Math.max(620, Math.round(H * 1.5)) : 0;
        const out = document.createElement("canvas");
        out.width = panelW + graphW; out.height = H;
        const g = out.getContext("2d")!;
        g.fillStyle = "#ffffff"; g.fillRect(0, 0, out.width, out.height);
        const px = (x: number) => (x - cx) * scale + panelW / 2, py = (y: number) => H / 2 - (y - cy) * scale;

        if (panelW) {
          // Onion skin: ghosts tinted cool (early) to warm (late), the last frame solid.
          gl1.width = panelW; gl1.height = H;
          gl.viewport(0, 0, panelW, H);
          renderer.camera.setViewport(panelW / scale, H / scale);
          renderer.camera.position.x = cx; renderer.camera.position.y = cy;
          renderer.camera.update();
          const ghosts = a.mode === "arcs" ? [n - 1] : Array.from({ length: Math.min(a.ghosts, n) }, (_, i) => Math.round((i * (n - 1)) / Math.max(1, Math.min(a.ghosts, n) - 1)));
          const draw = (k: number, tint: [number, number, number], alpha: number) => {
            sk.setupPose(); sk.update(0);
            // Replay to frame k so physics matches the sampled playback.
            for (let j = 0; j <= k; j++) pose(j);
            sk.color.set(tint[0], tint[1], tint[2], 1);
            gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
            renderer.begin(); renderer.drawSkeleton(sk); renderer.end();
            sk.color.set(1, 1, 1, 1);
            g.globalAlpha = alpha; g.drawImage(gl1, 0, 0); g.globalAlpha = 1;
          };
          ghosts.forEach((k, i) => {
            const last = i === ghosts.length - 1;
            const f = ghosts.length > 1 ? i / (ghosts.length - 1) : 1;
            draw(k, last ? [1, 1, 1] : [0.55 + 0.45 * f, 0.6, 1 - 0.45 * f], last ? 1 : 0.28);
          });
          // Arcs: one dot per frame (spacing chart), a line through them.
          if (a.mode !== "onion") {
            a.bones.forEach((name, i) => {
              const pts = arcs[i]!, col = a.colors[i % a.colors.length]!;
              g.strokeStyle = col; g.lineWidth = 2; g.beginPath();
              pts.forEach(([, x, y], j) => (j ? g.lineTo(px(x), py(y)) : g.moveTo(px(x), py(y))));
              g.stroke();
              g.fillStyle = col;
              for (const [, x, y] of pts) { g.beginPath(); g.arc(px(x), py(y), 3, 0, Math.PI * 2); g.fill(); }
              g.font = "bold 12px -apple-system, Helvetica, Arial, sans-serif";
              g.fillText(name, px(pts[0]![1]) + 6, py(pts[0]![2]) - 6);
            });
          }
        }
        if (graphW) {
          // Curves: local value per frame, keys marked, one row per channel.
          const x0 = panelW + 150, x1 = panelW + graphW - 16;
          const rows = Math.max(1, a.channels.length), rowH = (H - 40) / rows;
          g.font = "11px -apple-system, Helvetica, Arial, sans-serif";
          a.channels.forEach((c, i) => {
            const vals = values[i]!, col = a.colors[a.bones.indexOf(c.bone) % a.colors.length]!;
            const top = 16 + i * rowH, bottom = top + rowH - 14;
            let lo = Math.min(...vals), hi = Math.max(...vals);
            if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
            const X = (k: number) => x0 + ((x1 - x0) * k) / (n - 1), Y = (v: number) => bottom - ((bottom - top) * (v - lo)) / (hi - lo);
            g.strokeStyle = "#d8d8e0"; g.lineWidth = 1; g.beginPath(); g.moveTo(x0, bottom); g.lineTo(x1, bottom); g.moveTo(x0, top); g.lineTo(x0, bottom); g.stroke();
            g.fillStyle = "#555"; g.fillText(`${c.bone} ${c.channel}`, panelW + 6, top + 10);
            g.fillText(hi.toFixed(1), panelW + 6, top + 24); g.fillText(lo.toFixed(1), panelW + 6, bottom);
            g.strokeStyle = col; g.lineWidth = 2; g.beginPath();
            vals.forEach((v, k) => (k ? g.lineTo(X(k), Y(v)) : g.moveTo(X(k), Y(v))));
            g.stroke();
            g.fillStyle = col;
            for (const t of c.keys) {
              const k = Math.min(n - 1, Math.max(0, Math.round(t * a.fps)));
              g.beginPath(); g.moveTo(X(k), Y(vals[k]!) - 5); g.lineTo(X(k) + 5, Y(vals[k]!)); g.lineTo(X(k), Y(vals[k]!) + 5); g.lineTo(X(k) - 5, Y(vals[k]!)); g.fill();
            }
          });
          g.fillStyle = "#555";
          const dur = (n - 1) / a.fps, step = dur > 4 ? 1 : dur > 1.5 ? 0.5 : 0.1;
          for (let t = 0; t <= dur + 1e-9; t += step) g.fillText(`${+t.toFixed(2)}s`, x0 + ((x1 - x0) * t) / dur - 8, H - 8);
        }
        resolve({ png: out.toDataURL("image/png"), arcs, values, projection: { cx, cy, scale, width: panelW, height: H } });
      };
      for (const page of atlas.pages) {
        const img = new Image();
        img.onload = () => { page.setTexture(new spine.GLTexture(ctx, img, true)); if (--pending === 0) go(); };
        img.onerror = () => reject(new Error(`texture ${page.name} failed to load`));
        img.src = a.pages[page.name]!;
      }
      if (pending === 0) go();
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Animator's views of one animation, drawn with spine-webgl: onion skin, arcs with a dot per frame (a spacing chart),
 * and value curves with keys marked. The numbers behind them come back too.
 */
export async function motionVisual(config: Config, cli: SpineCli, o: MotionVisualOptions): Promise<MotionVisualResult> {
  const mode = o.mode ?? "all";
  const fps = o.fps ?? 30;
  const loaded = await loadProject(config, cli, o.project);
  const sk = pickSkeleton(loaded, o.skeleton);
  const animJson = sk.doc.animations?.[o.animation];
  if (!animJson) throw new UserError(`Animation "${o.animation}" not found. Available: ${Object.keys(sk.doc.animations ?? {}).join(", ")}`);
  let bones = o.bones?.length ? o.bones : [];
  for (const b of bones) if (!sk.doc.bones.some((x) => x.name === b)) throw new UserError(`Unknown bone: ${b}`);
  if (!bones.length) {
    const m = measureMotion(sampleAnimation(loadSkeletonData(sk.doc, sk.name), o.animation, { fps }));
    // Bones this animation keys (what the animator posed), furthest travelled first.
    const strip = ({ time: _t, curve: _c, ...rest }: Record<string, unknown>) => JSON.stringify(rest);
    const keyed = new Set(Object.entries(animJson.bones ?? {})
      .filter(([, tls]) => Object.values(tls).some((keys) => keys.length > 1 && keys.some((k) => strip(k) !== strip(keys[0]!))))
      .map(([b]) => b));
    const pool = m.bones.filter((b) => b.bone !== sk.doc.bones[0]?.name && (keyed.size ? keyed.has(b.bone) : true));
    bones = [...pool].sort((x, y) => y.position.pathLength - x.position.pathLength).slice(0, 3).map((b) => b.bone);
  }
  bones = bones.slice(0, 6);
  // Channels with keys in this animation (rotation first); bones without keys still get rotation.
  const channels: PageArgs["channels"] = [];
  for (const b of bones) {
    const tls = animJson.bones?.[b] ?? {};
    const keyed = Object.keys(tls).filter((p) => BONE_CHANNELS[p]);
    const list: [string, string][] = [];
    for (const p of keyed.length ? keyed : ["rotate"]) {
      if (p === "rotate") list.push(["rotate", p]);
      else if (p === "translate") list.push(["x", p], ["y", p]);
      else if (p === "translatex") list.push(["x", p]); else if (p === "translatey") list.push(["y", p]);
      else if (p === "scale") list.push(["scaleY", p]);
    }
    for (const [ch, p] of list) channels.push({ bone: b, channel: ch, keys: (tls[p] ?? []).map((k) => k.time ?? 0) });
  }
  const plot = channels.slice(0, 8);

  const work = join(config.workDir, "web", `viz-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(work, { recursive: true });
  try {
    const ex = await exportRuntime(config, cli, { project: o.project, outputDir: join(work, "export"), format: "json", premultipliedAlpha: true });
    const jsonFile = ex.files.find((f) => f.name === `${sk.name}.json`) ?? ex.files.find((f) => f.name.endsWith(".json"))!;
    const atlasFile = ex.files.find((f) => f.name.endsWith(".atlas") && !f.name.includes("@"))!;
    const pages: Record<string, string> = {};
    for (const f of ex.files.filter((x) => x.name.endsWith(".png") && !x.name.includes("@"))) pages[f.name] = `data:image/png;base64,${readFileSync(join(work, "export", f.name)).toString("base64")}`;
    const browser = await launchChrome("motion visuals");
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.setContent(PAGE);
      await page.addScriptTag({ path: SPINE_WEBGL });
      const r = await page.evaluate(vizInPage, {
        atlas: readFileSync(join(work, "export", atlasFile.name), "utf8"), json: readFileSync(join(work, "export", jsonFile.name), "utf8"), pages,
        animation: o.animation, fps, bones, channels: plot, mode, ghosts: o.ghosts ?? 8, size: o.size ?? 520, colors: COLORS,
      });
      if (errors.length) throw new UserError(`spine-webgl: ${errors[0]}`);
      const round = (v: number) => +v.toFixed(2);
      const arcs = bones.map((bone, i) => {
        const pts = r.arcs[i]!;
        const steps = pts.slice(1).map((p, j) => Math.hypot(p[1] - pts[j]![1], p[2] - pts[j]![2]));
        // Long animations: every frame is drawn, the data is thinned to stay readable.
        const every = Math.max(1, Math.ceil(pts.length / 120));
        return {
          bone, points: pts.filter((_, j) => j % every === 0 || j === pts.length - 1).map(([t, x, y]) => [t, round(x), round(y)] as [number, number, number]),
          pathLength: round(steps.reduce((s, v) => s + v, 0)), maxStep: round(Math.max(0, ...steps)), minStep: round(steps.length ? Math.min(...steps) : 0),
        };
      });
      const curves = plot.map((c, i) => {
        const every = Math.max(1, Math.ceil(r.values[i]!.length / 120));
        return { bone: c.bone, channel: c.channel, values: r.values[i]!.filter((_, j) => j % every === 0).map(round), keys: c.keys.map((t) => +t.toFixed(4)) };
      });
      return {
        animation: o.animation, mode, fps, frames: r.arcs[0]?.length ?? 0, bones, arcs, curves,
        projection: { ...r.projection, cx: round(r.projection.cx), cy: round(r.projection.cy), scale: +r.projection.scale.toFixed(5) },
        notes: [
          "Arcs: one dot per frame, so dot spacing is the spacing chart (bunched = slow / easing, spread = fast). Onion skin: early frames cool, late frames warm, the last frame solid.",
          "Curves: local bone values (setup pose included) per frame; diamonds mark keys. Drawn with spine-webgl, playback sequential with physics stepped.",
          ...(arcs.some((x) => x.points.length < (r.arcs[0]?.length ?? 0)) ? ["Long animation: data thinned to about 120 samples per bone; the picture shows every frame."] : []),
        ],
        png: Buffer.from(r.png.split(",")[1]!, "base64"),
      };
    } finally {
      await browser.close();
    }
  } finally {
    removeQuiet(work);
  }
}
