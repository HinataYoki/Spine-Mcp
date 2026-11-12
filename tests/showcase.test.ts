import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { SpineCli } from "../src/spine/cli.js";
import { makeShowcase } from "../src/spine/showcase.js";

// Argument checks run before any render, so they need no Spine.
describe("spine_showcase argument checks", () => {
  const config = loadConfig();
  const cli = new SpineCli(config);
  const base = { project: "/x/a.spine", items: [{ animation: "idle" }] };
  it("needs an absolute output with a supported extension", async () => {
    await expect(makeShowcase(config, cli, { ...base, output: "out.webp" })).rejects.toThrow(/absolute/);
    await expect(makeShowcase(config, cli, { ...base, output: "/tmp/out.png" })).rejects.toThrow(/\.webp, \.gif or \.mp4/);
  });
  it("takes 1 to 4 items and refuses transparency where the format cannot keep it", async () => {
    await expect(makeShowcase(config, cli, { ...base, items: [], output: "/tmp/x.webp" })).rejects.toThrow(/1 to 4/);
    await expect(makeShowcase(config, cli, { ...base, output: "/tmp/x-showcase-test.gif", background: "transparent" })).rejects.toThrow(/transparent background needs \.webp/);
    await expect(makeShowcase(config, cli, { ...base, output: "/tmp/x-showcase-test.mp4", background: "blue" })).rejects.toThrow(/hex colour/);
  });
});
