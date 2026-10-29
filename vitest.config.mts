import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.dirname(fileURLToPath(import.meta.url)) } },
  test: { include: ["lib/**/*.test.ts"] },
});
