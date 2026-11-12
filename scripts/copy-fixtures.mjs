// Copies official spine-runtimes example projects into .lab/fixtures (git-ignored; Spine Runtimes License).
// Usage: SPINE_EXAMPLES=/path/to/spine-runtimes/examples npm run fixtures
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const examples = process.env.SPINE_EXAMPLES ?? join(homedir(), "spine-runtimes/examples");
const names = ["spineboy", "raptor", "celestial-circus", "owl", "alien", "diamond", "goblins", "tank", "vine", "stretchyman"];
const out = join(process.cwd(), ".lab", "fixtures");

if (!existsSync(examples)) {
  console.error(`Examples folder not found: ${examples} (set SPINE_EXAMPLES)`);
  process.exit(1);
}
for (const name of names) {
  const src = join(examples, name);
  const project = join(src, `${name}-pro.spine`);
  if (!existsSync(project)) {
    console.warn(`skip ${name}: no ${name}-pro.spine`);
    continue;
  }
  const dst = join(out, name);
  mkdirSync(dst, { recursive: true });
  cpSync(project, join(dst, `${name}-pro.spine`));
  // The Essential version of the same character, when there is one (Pro -> Essential transfers).
  const ess = join(src, `${name}-ess.spine`);
  if (existsSync(ess)) cpSync(ess, join(dst, `${name}-ess.spine`));
  if (existsSync(join(src, "images"))) cpSync(join(src, "images"), join(dst, "images"), { recursive: true });
  console.log(`copied ${name}`);
}
