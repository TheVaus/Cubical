/// <reference types="vitest" />
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Vite is configured for Tauri 2:
// - Fixed port 5173 with strictPort so Tauri's devUrl is reliable.
// - clearScreen: false so Vite doesn't wipe Tauri's stdout.
// - HMR uses a fixed port for Tauri's webview to reconnect cleanly.

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Don't watch the Rust side — Tauri does its own watching there.
      ignored: ["**/crates/**", "**/target/**"],
    },
  },
  // Tauri expects a fixed dist location (matches frontendDist in tauri.conf.json).
  build: {
    target: "es2022",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    // Vitest runs in node by default; the AST normalizer + frontmatter
    // splitter are pure functions with no DOM dependency, so node is
    // the right environment. Component tests (deferred) would need
    // jsdom or happy-dom.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
