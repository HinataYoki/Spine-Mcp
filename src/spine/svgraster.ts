import { execFileSync, fontCandidates } from "../platform.js";
import { existsSync, writeFileSync } from "node:fs";

/**
 * Charts are written as plain SVG (rect, line, circle, text) but drawn with ImageMagick's own draw language (MVG):
 * its built-in SVG reader paints every <line> black whatever its stroke (GOTCHAS G59), which turned coloured curves
 * and markers into black ones.
 */
export function svgToMvg(svg: string): { width: number; height: number; mvg: string } {
  const root = /<svg\b([^>]*)>/.exec(svg);
  if (!root) throw new Error("not an SVG");
  const num = (attrs: string, name: string, fallback = 0) => {
    const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
    const v = m ? parseFloat(m[1]!) : NaN;
    return Number.isFinite(v) ? v : fallback;
  };
  const str = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
  const width = num(root[1]!, "width"), height = num(root[1]!, "height");
  const out = [`viewbox 0 0 ${width} ${height}`];
  const colour = (c: string | undefined) => (c && c !== "none" ? `"${c}"` : "none");
  for (const m of svg.matchAll(/<(rect|line|circle|text)\b([^>]*?)(?:\/>|>([^<]*)<\/text>)/g)) {
    const [, tag, a, content] = m as unknown as [string, string, string, string | undefined];
    const g: string[] = ["push graphic-context"];
    if (tag === "rect") {
      const x = num(a, "x"), y = num(a, "y");
      g.push(`stroke none`, `fill ${colour(str(a, "fill") ?? "#000000")}`, `rectangle ${x},${y} ${x + num(a, "width")},${y + num(a, "height")}`);
    } else if (tag === "line") {
      g.push(`fill none`, `stroke ${colour(str(a, "stroke") ?? "#000000")}`, `stroke-width ${num(a, "stroke-width", 1)}`);
      const dash = str(a, "stroke-dasharray");
      if (dash) g.push(`stroke-dasharray ${dash.split(/[ ,]+/).join(" ")}`);
      g.push(`line ${num(a, "x1")},${num(a, "y1")} ${num(a, "x2")},${num(a, "y2")}`);
    } else if (tag === "circle") {
      const cx = num(a, "cx"), cy = num(a, "cy");
      g.push(`stroke none`, `fill ${colour(str(a, "fill") ?? "#000000")}`, `circle ${cx},${cy} ${cx + num(a, "r")},${cy}`);
    } else {
      const text = (content ?? "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      g.push(`stroke none`, `fill ${colour(str(a, "fill") ?? "#000000")}`, `font-size ${num(a, "font-size", 12)}`, `text ${num(a, "x")},${num(a, "y")} '${text}'`);
    }
    g.push("pop graphic-context");
    out.push(g.join("\n"));
  }
  return { width, height, mvg: out.join("\n") };
}

/** ImageMagick needs a font file for text (G59). */
const FONTS = fontCandidates();

/** Draws a chart SVG to PNG with ImageMagick (see svgToMvg); without any font file the labels are left out. */
export function rasterizeSvg(svg: string, mvgFile: string, png: string, font?: string): void {
  font ??= FONTS.find((f) => existsSync(f));
  const { width, height, mvg } = svgToMvg(font ? svg : svg.replace(/<text\b[^>]*>[^<]*<\/text>/g, ""));
  writeFileSync(mvgFile, mvg);
  execFileSync("magick", ["-size", `${width}x${height}`, "xc:white", ...(font ? ["-font", font] : []), "-draw", `@${mvgFile}`, png], { stdio: "ignore", timeout: 60_000 });
}
