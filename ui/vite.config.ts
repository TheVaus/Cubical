/// <reference types="vitest" />
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const designSystemSrc = fileURLToPath(
  new URL("../design-system/src", import.meta.url),
);

export default defineConfig({
  plugins: [solid()],
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
});
