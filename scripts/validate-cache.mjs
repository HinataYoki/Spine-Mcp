// Runs the validator over every exported skeleton in the server cache (after `npm run build`).
// Usage: node scripts/validate-cache.mjs [cacheExportsDir]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { validateSkeleton } from "../dist/spine/validate.js";

const dir = process.argv[2] ?? join(homedir(), "Library/Caches/spine-mcp/exports");
if (!existsSync(dir)) {
  console.error(`No cache at ${dir}`);
  process.exit(1);
}
for (const sub of readdirSync(dir).sort()) {
  for (const f of readdirSync(join(dir, sub)).filter((x) => x.endsWith(".json"))) {
    const doc = JSON.parse(readFileSync(join(dir, sub, f), "utf8"));
    const t0 = performance.now();
    const issues = validateSkeleton(doc);
    const ms = (performance.now() - t0).toFixed(0);
    const lines = issues.map((i) => `    ${i.severity}:${i.code}: ${i.message.slice(0, 160)}`);
    console.log(`${f} (${ms} ms)${lines.length ? "" : " clean"}`);
    if (lines.length) console.log(lines.join("\n"));
  }
}
