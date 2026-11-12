import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { cliWorkingDir, SpineCli } from "../src/spine/cli.js";
import { skelDataVersion } from "../src/spine/project.js";

const root = mkdtempSync(join(tmpdir(), "spine-mcp-cwd-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("where the Spine CLI runs (G115)", () => {
  it("runs in an empty folder of the work folder, not where the server was started", async () => {
    // A stand-in CLI (node) that prints its working folder; the server's own folder holds a "json" entry.
    const started = join(root, "client"), config = { ...loadConfig(), spineBin: process.execPath, workDir: join(root, "work") };
    mkdirSync(join(started, "json"), { recursive: true });
    const before = process.cwd();
    process.chdir(started);
    try {
      const r = await new SpineCli(config).run(["-e", "console.log(process.cwd())"], { pin: false });
      expect(r.exitCode).toBe(0);
      expect(realpathSync(r.lines[0]!)).toBe(realpathSync(cliWorkingDir(config)));
    } finally {
      process.chdir(before);
    }
    expect(readdirSync(cliWorkingDir(config))).toEqual([]);
  });
});

describe("the version binary skeleton data was exported with", () => {
  const skel = (version: string | null) => {
    // Header: hash as two int32, then the version as a length-prefixed string (length + 1, 0 = null).
    const v = version === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([Buffer.byteLength(version) + 1]), Buffer.from(version)]);
    const file = join(root, `${version ?? "none"}.skel`);
    writeFileSync(file, Buffer.concat([Buffer.from([0xac, 0x70, 0xf2, 0x7c, 0x4e, 0x7c, 0xd6, 0x9a]), v, Buffer.alloc(16)]));
    return file;
  };

  it("reads it from the header, not from the CLI that exports the data to JSON", () => {
    expect(skelDataVersion(skel("4.3.23"))).toBe("4.3.23");
    expect(skelDataVersion(skel("4.2.43"))).toBe("4.2.43");
  });

  it("gives null for data without a readable version", () => {
    expect(skelDataVersion(skel(null))).toBeNull();
    const junk = join(root, "junk.skel");
    writeFileSync(junk, Buffer.from("not a skeleton at all, just text"));
    expect(skelDataVersion(junk)).toBeNull();
    writeFileSync(join(root, "empty.skel"), "");
    expect(skelDataVersion(join(root, "empty.skel"))).toBeNull();
    expect(skelDataVersion(join(root, "missing.skel"))).toBeNull();
  });
});
