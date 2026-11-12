// Writes the README diagrams in light and dark variants: docs/media/flow-*.svg and docs/media/pillars-*.svg.
// Usage: node scripts/make-readme-art.mjs
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const media = join(process.cwd(), "docs", "media");
const FONT = `-apple-system, 'SF Pro Text', 'Segoe UI', 'Helvetica Neue', Arial, sans-serif`;
const THEMES = {
  dark: { ground: "#0E1029", card: "#1C2050", cardStroke: "#6B5CFF", hot: "#5B3FE0", hotStroke: "#B9AEFF", text: "#EEF0FF", sub: "#B4B9E6", line: "#8F7BFF", cyan: "#4FF3E0", orange: "#FFB547" },
  light: { ground: "#F4F5FF", card: "#FFFFFF", cardStroke: "#8F7BFF", hot: "#5B3FE0", hotStroke: "#3E33A8", text: "#141833", sub: "#555B8A", line: "#6B5CFF", cyan: "#0FB5A6", orange: "#E08A1E" },
};
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function box(t, x, y, w, h, title, lines, hot = false, tag) {
  const fill = hot ? t.hot : t.card, stroke = hot ? t.hotStroke : t.cardStroke, ink = hot ? "#FFFFFF" : t.text, sub = hot ? "#E4E0FF" : t.sub;
  const cx = x + w / 2, top = y + h / 2 - (lines.length * 18) / 2 - 2;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
  ${tag ? `<rect x="${x + 14}" y="${y - 11}" width="${tag.length * 7.6 + 16}" height="22" rx="11" fill="${tag === "writes" ? t.orange : t.cyan}"/><text x="${x + 22}" y="${y + 4}" font-size="12" font-weight="700" fill="#0E1029">${tag}</text>` : ""}
  <text x="${cx}" y="${top}" font-size="18" font-weight="700" fill="${ink}" text-anchor="middle">${esc(title)}</text>
  ${lines.map((l, i) => `<text x="${cx}" y="${top + 24 + i * 18}" font-size="13.5" fill="${sub}" text-anchor="middle">${esc(l)}</text>`).join("\n  ")}`;
}

function flow(t) {
  const arrow = (x1, y1, x2, y2) => `<path d="M${x1} ${y1} C${(x1 + x2) / 2} ${y1} ${(x1 + x2) / 2} ${y2} ${x2} ${y2}" fill="none" stroke="${t.line}" stroke-width="2.5" marker-end="url(#arrow)"/>`;
  const rows = [[24, "Spine CLI", "export · render · import -a"], [100, "Spine 4.3 JSON", "read, diff, author keys"], [176, "spine-core 4.3", "sample · compare · load"], [252, "Unity + spine-unity", "headless import · parity"]];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="340" viewBox="0 0 1000 340" role="img" aria-label="How spine-mcp works: an AI agent calls spine-mcp, which uses the Spine CLI, Spine JSON, spine-core and a headless Unity to read, check and safely edit a .spine project">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="${t.line}"/></marker></defs>
  <rect width="1000" height="340" rx="18" fill="${t.ground}"/>
  <g font-family="${FONT}">
  ${box(t, 24, 120, 170, 100, "AI agent", ["Claude Code,", "any MCP client"])}
  ${box(t, 246, 100, 210, 140, "spine-mcp", ["37 tools · stdio", "validate, measure, render", "derive, verify, roll back"], true)}
  ${rows.map(([y, title, sub]) => box(t, 520, y, 220, 64, title, [sub])).join("\n  ")}
  ${box(t, 800, 120, 176, 100, "your .spine", ["backed up before", "every write"], false, "writes")}
  </g>
  ${arrow(194, 170, 244, 170)}
  ${rows.map(([y]) => arrow(456, 170, 518, y + 32)).join("")}
  ${arrow(740, 56, 798, 150)}${arrow(740, 132, 798, 170)}
</svg>
`;
}

const PILLARS = [
  ["Start", "PSD to project · auto rig", "new art in · inspect", "#4FF3E0"],
  ["Check", "validate what Spine drops", "rig QA · mix · budget", "#8E9BFF"],
  ["See", "Spine's renders · reviews", "video frame by frame", "#FFB547"],
  ["Edit & ship", "derive · generate · lip sync", "verified writes · Unity", "#B9AEFF"],
];

function pillars(t) {
  const w = 225, gap = 20, h = 132;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${h + 40}" viewBox="0 0 1000 ${h + 40}" role="img" aria-label="Start from a PSD, check, see and review, edit and ship Spine animations safely">
  <rect width="1000" height="${h + 40}" rx="18" fill="${t.ground}"/>
  <g font-family="${FONT}">
  ${PILLARS.map(([title, a, b, color], i) => {
    const x = 20 + i * (w + gap), y = 20;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${t.card}" stroke="${t.cardStroke}" stroke-opacity="0.6"/>
    <rect x="${x}" y="${y}" width="${w}" height="6" rx="3" fill="${color}"/>
    <text x="${x + 22}" y="${y + 30 + 18}" font-size="24" font-weight="800" fill="${t.text}">${i + 1}. ${esc(title)}</text>
    <text x="${x + 22}" y="${y + 84}" font-size="14.5" fill="${t.sub}">${esc(a)}</text>
    <text x="${x + 22}" y="${y + 106}" font-size="14.5" fill="${t.sub}">${esc(b)}</text>`;
  }).join("\n  ")}
  </g>
</svg>
`;
}

for (const [name, t] of Object.entries(THEMES)) {
  writeFileSync(join(media, `flow-${name}.svg`), flow(t));
  writeFileSync(join(media, `pillars-${name}.svg`), pillars(t));
}
console.log("flow-*.svg, pillars-*.svg written");
