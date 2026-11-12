// CI gate: validate + rig QA + budget for every Spine project under a folder; exits 1 when anything fails.
// Usage: npm run build && node scripts/audit.mjs <folder> [--strict] [--limits '{"vertexTransforms":3000,"drawCalls":4}']
import { resolve } from "node:path";
import { loadConfig } from "../dist/config.js";
import { SpineCli } from "../dist/spine/cli.js";
import { auditFolder } from "../dist/spine/audit.js";

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--limits");
if (!folder) { console.error("usage: node scripts/audit.mjs <folder> [--strict] [--limits <json>]"); process.exit(2); }
const li = args.indexOf("--limits");
const config = loadConfig();
const r = await auditFolder(config, new SpineCli(config), resolve(folder), { strict: args.includes("--strict"), limits: li >= 0 ? JSON.parse(args[li + 1]) : undefined });
for (const row of r.rows) {
  const why = [...row.validate.firstErrors, ...row.rigQa.warningCodes, ...row.budget.overBudget].join("; ");
  console.log(`${row.ok ? "ok  " : "FAIL"} ${row.file} [${row.skeleton}] vt=${row.budget.vertexTransforms} dc=${row.budget.drawCalls}${why ? `  ${why}` : ""}`);
}
for (const e of r.errors) console.log(`ERR  ${e.file}  ${e.error}`);
console.log(`\n${r.skeletons} skeleton(s) in ${r.files} file(s), ${r.failed} failed, ${r.errors.length} error(s), ${r.seconds}s`);
process.exitCode = r.ok ? 0 : 1;
