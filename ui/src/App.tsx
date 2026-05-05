import type { Component } from "solid-js";

/**
 * Layer 0 placeholder UI.
 *
 * Empty window with a heading. The point at L0 is to prove the
 * Tauri + Vite + Solid + token-surface integration is healthy.
 * Real UI lands at L2.
 */
const App: Component = () => {
  return (
    <main
      style={{
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        "justify-content": "center",
        "min-height": "100vh",
        padding: "var(--space-6)",
        gap: "var(--space-3)",
      }}
    >
      <h1 style={{ "font-size": "var(--text-2xl)", margin: 0 }}>Cubical</h1>
      <p
        style={{
          color: "var(--c-fg-secondary)",
          "font-size": "var(--text-sm)",
          margin: 0,
        }}
      >
        Layer 0 — Bedrock
      </p>
    </main>
  );
};

export default App;
