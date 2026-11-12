import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { rasterizeSvg, svgToMvg } from "../src/spine/svgraster.js";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><rect width="200" height="80" fill="#ffffff"/>`
  + `<rect x="10" y="40" width="30" height="20" fill="#e9eef7"/>`
  + `<line x1="10" y1="10" x2="190" y2="10" stroke="#e4572e" stroke-width="3"/>`
  + `<line x1="10" y1="30" x2="190" y2="30" stroke="#d81159" stroke-dasharray="3,3"/>`
  + `<circle cx="100" cy="60" r="6" fill="#2e86ab"/>`
  + `<text x="120" y="70" font-size="11" fill="#555">0.5s 'peak' &amp; hold</text></svg>`;

const hasMagick = (() => { try { execFileSync("magick", ["-version"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe("chart rasterizing (ImageMagick's SVG reader drew every line black)", () => {
  it("turns the chart elements into MVG with their colours, dashes and escaped text", () => {
    const { width, height, mvg } = svgToMvg(SVG);
    expect([width, height]).toEqual([200, 80]);
    expect(mvg).toContain('stroke "#e4572e"');
    expect(mvg).toContain("stroke-width 3");
    expect(mvg).toContain("line 10,10 190,10");
    expect(mvg).toContain("stroke-dasharray 3 3");
    expect(mvg).toContain('fill "#2e86ab"');
    expect(mvg).toContain("circle 100,60 106,60");
    expect(mvg).toContain("rectangle 10,40 40,60");
    expect(mvg).toContain("text 120,70 '0.5s \\'peak\\' & hold'");
  });

  it.skipIf(!hasMagick)("draws a coloured line in its colour", () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-svgraster-"));
    const png = join(dir, "c.png");
    rasterizeSvg(SVG, join(dir, "c.mvg"), png);
    const img = PNG.sync.read(readFileSync(png));
    const at = (x: number, y: number) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
    const [r, g, b] = at(100, 10);
    expect(r).toBeGreaterThan(180); // orange, not black
    expect(g).toBeLessThan(140);
    expect(b).toBeLessThan(100);
    expect(at(100, 60)[2]).toBeGreaterThan(140); // the blue peak dot
  });
});
