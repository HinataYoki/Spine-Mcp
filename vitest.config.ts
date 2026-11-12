import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/legacy-demo/**"],

    testTimeout: 120_000,
    // Integration hooks export through the Spine CLI; under a full parallel run a cold start can pass 10 s.
    hookTimeout: 120_000,
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup-editor.ts"],
  },
});
