/// <reference types="vitest" />
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const designSystemSrc = fileURLToPath(
  new URL("../design-system/src", import.meta.url),
);

export default defineConfig(({ mode }) => ({
  // hot is disabled under test because solid-refresh serves its runtime from
  // the virtual path "/@solid-refresh". On Windows, Node rejects that as
  // "file:///@solid-refresh" — not an absolute path — and the whole vitest run
  // dies. Hot reload has no meaning in a test process, so there is nothing to
  // trade away. Vitest sets mode to "test"; dev and build are unaffected.
  plugins: [solid({ hot: mode !== "test" })],
  clearScreen: false,
  resolve: {
    alias: { "@ds": designSystemSrc },
    dedupe: ["solid-js"],
  },
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    fs: { allow: [repoRoot] },
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/crates/**", "**/target/**"],
    },
  },
  build: {
    target: "es2022",
    minify: !process.env.TAURI_DEBUG ? "oxc" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
}));
