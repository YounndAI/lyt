import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // npm pack --dry-run --json over 5 workspaces is slow on Windows; allow headroom.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
