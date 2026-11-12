import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withBatchLock } from "../src/spine/unity.js";

// Two Unity batch jobs on one cached project break its compilation (CS2011): processes sharing a work folder take
// turns through a lock file there.
describe("Unity batch lock across processes", () => {
  it("waits while a live process holds the lock and runs once it is released", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-lock-"));
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      writeFileSync(join(dir, "batch.lock"), JSON.stringify({ pid: holder.pid, at: Date.now() }));
      const t0 = Date.now();
      setTimeout(() => holder.kill(), 1500);
      const ran = await withBatchLock(dir, async () => Date.now() - t0);
      expect(ran).toBeGreaterThanOrEqual(1400);
      expect(existsSync(join(dir, "batch.lock"))).toBe(false);
    } finally {
      holder.kill();
    }
  });

  it("takes over a lock whose owner is gone, and releases it when the job throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-lock-"));
    const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise((r) => gone.on("exit", r));
    writeFileSync(join(dir, "batch.lock"), JSON.stringify({ pid: gone.pid, at: Date.now() }));
    const t0 = Date.now();
    await expect(withBatchLock(dir, async () => { throw new Error("unity failed"); })).rejects.toThrow("unity failed");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(existsSync(join(dir, "batch.lock"))).toBe(false);
  });

  it("takes over a lock nobody has rewritten for minutes, even with a live pid (a reused pid, a hung holder)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-lock-"));
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    try {
      const file = join(dir, "batch.lock"), old = Date.now() - 10 * 60_000;
      writeFileSync(file, JSON.stringify({ pid: holder.pid, at: old }));
      utimesSync(file, old / 1000, old / 1000);
      const t0 = Date.now();
      await withBatchLock(dir, async () => undefined);
      expect(Date.now() - t0).toBeLessThan(1000);
    } finally {
      holder.kill();
    }
  });

  it("takes over this process's own leftover lock, and waits on a lock still being written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-lock-"));
    const file = join(dir, "batch.lock");
    writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const t0 = Date.now();
    await withBatchLock(dir, async () => undefined);
    expect(Date.now() - t0).toBeLessThan(1000);
    // Empty content (created, not yet written) is fresh: wait, then run once it is released.
    writeFileSync(file, "");
    setTimeout(() => writeFileSync(file, JSON.stringify({ pid: 999999, at: Date.now() })), 300);
    const t1 = Date.now();
    const ran = await withBatchLock(dir, async () => Date.now() - t1);
    expect(ran).toBeGreaterThanOrEqual(250);
  });

  it("releases only its own lock: one taken over meanwhile stays with its new holder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spine-mcp-lock-"));
    const file = join(dir, "batch.lock"), other = JSON.stringify({ pid: 1, at: Date.now(), token: "someone-else" });
    await withBatchLock(dir, async () => { writeFileSync(file, other); });
    expect(readFileSync(file, "utf8")).toBe(other);
  });
});
