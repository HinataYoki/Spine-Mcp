// npm run test:spine: the integration tests (a licensed Spine install; SPINE_UNITY=1 adds the Unity ones). The
// environment is set here, not in package.json, because "VAR=1 command" does not work in Windows' cmd.exe.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const vitest = join(import.meta.dirname, "..", "node_modules", "vitest", "vitest.mjs");
const vitestRun = (args) => spawnSync(process.execPath, [vitest, "run", ...args], { stdio: "inherit", env: { ...process.env, SPINE_INTEGRATION: "1" } }).status ?? 1;
const alone = ["tests/video-integration.test.ts"];
const args = process.argv.slice(2);
process.exit(args.length ? vitestRun(args) : Math.max(vitestRun(alone.flatMap((f) => ["--exclude", f])), vitestRun(alone)));
