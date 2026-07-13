# Cubical Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete SolidJS design system for Cubical (a local-first Markdown knowledge base): token system, full component inventory, and workspace/empty-vault/settings/gallery screens.

**Architecture:** Vite + SolidJS + TypeScript app. CSS custom properties in `src/styles/tokens.css` (base tokens + semantic aliases + three `[data-theme]` scopes) consumed by every component's co-located CSS file — no hardcoded hex/px anywhere else. A signal-based screen switcher (no router) toggles between Gallery/Workspace/Empty vault/Settings. Mock data lives in static fixtures. The editor column uses real `@codemirror/*` packages themed via `EditorView.theme()` referencing our CSS variables.

**Tech Stack:** solid-js, vite, vite-plugin-solid, typescript, @codemirror/state, @codemirror/view, @codemirror/commands, @codemirror/lang-markdown.

## Global Constraints

- SolidJS only — no React, no React-derived deps in `package.json`. Solid idioms: `createSignal`, `createMemo`, `<Show>`, `<For>`, `props.x` (never destructured), `class` not `className`.
- Styling: plain CSS custom properties + co-located `.css` files. No CSS-in-JS, no Tailwind (CodeMirror's `EditorView.theme()` is the one required exception, and it must reference `var(--c-*)` tokens, not hardcoded values).
- Every color/spacing/radius/type/motion/shadow value in component CSS comes from a token defined in `src/styles/tokens.css` — no hardcoded hex or px in components.
- Color: warm-neutral cream `#faf8f3` (light) / warm near-black `#181610` (dark), never blue-grey. Ship `light`, `dark`, `high-contrast` themes via `[data-theme]` scopes on `<html>`.
- `--c-accent` means STATE only (selection, active, focus, caret, resolved links/tags) — never decoration.
- Selected list item = `box-shadow: inset 2px 0 0 var(--c-accent)` over `--c-bg-tertiary` fill, never an accent background.
- Motion: `transform`/`opacity` only. 120ms for state changes, 200ms for surfaces. `prefers-reduced-motion: reduce` collapses both to 0ms.
- Focus-visible: `2px solid var(--c-focus-ring)`, `outline-offset: 2px`, always present, keyboard-first.
- Shadows (`sm`/`md`/`lg`) only on transient overlays (menu, modal, toast, tooltip). Modal scrim = `rgba(0,0,0,.5)`.
- Type: native system stacks only, no webfonts. Sans for prose, mono for machinery (extensions, keys, counts, paths, code). Sentence case for UI labels; UPPERCASE + letter-spacing only for small mono eyebrows. No emoji, ever.
- File-tree rows are a fixed 32px height.
- No gradients, no photography, no illustration, no texture.

---

## Component & prop reference

Later tasks depend on these exact signatures. Do not deviate from them.

- `Button({ variant?: 'primary' | 'secondary'; disabled?: boolean; type?: 'button' | 'submit'; onClick?: (e: MouseEvent) => void; children: JSX.Element })`
- `IconButton({ label: string; active?: boolean; disabled?: boolean; onClick?: (e: MouseEvent) => void; children: JSX.Element })`
- `TextInput({ value: string; onInput: (value: string) => void; placeholder?: string; disabled?: boolean; type?: string })`
- `Toggle({ checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label: string })`
- `SegmentedControl({ options: { label: string; value: string }[]; value: string; onChange: (value: string) => void })`
- `Badge({ tone?: 'neutral' | 'success' | 'warning' | 'error'; children: JSX.Element })`
- `Callout({ tone?: 'neutral' | 'success' | 'warning' | 'error'; title?: string; children: JSX.Element })`
- `Toast({ tone?: 'neutral' | 'success' | 'warning' | 'error'; message: string; onDismiss: () => void; autoDismissMs?: number })`
- `Tooltip({ label: string; placement?: 'top' | 'bottom' | 'left' | 'right'; children: JSX.Element })`
- `Tag({ label: string; resolved?: boolean; onClick?: () => void })`
- `FileIcon({ kind: 'folder' | 'folder-open' | 'md' | 'txt' | 'png' | 'svg' | 'pdf' | 'code' | 'canvas' | 'broken' })`
- `FileTreeRow({ name: string; depth: number; kind: FileKind; selected?: boolean; invalid?: boolean; renaming?: boolean; onClick?: () => void; onRenameCommit?: (name: string) => void })`
- `BacklinkRow({ noteTitle: string; snippet: string; matchQuery?: string; onClick?: () => void })`
- `Menu({ items: { id: string; label: string; shortcut?: string; disabled?: boolean; onSelect: () => void }[] })`
- `Modal({ open: boolean; onClose: () => void; title?: string; children: JSX.Element })`
- `CommandPalette({ open: boolean; onClose: () => void; commands: { id: string; label: string; onRun: () => void }[] })`
- `CubeMark({ size?: number })`
- `theme()` (accessor) / `applyTheme(name: 'light' | 'dark' | 'high-contrast')` from `src/theme.ts`
- `screen()` (accessor) / `setScreen(name: 'workspace' | 'empty-vault' | 'settings' | 'gallery')` from `src/App.tsx`

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/main.tsx`
- Create: `src/App.tsx`
- Create: `.gitignore`

**Interfaces:**
- Produces: a running Vite dev server rendering `<App />` into `#root`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "cubical-design-system",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "solid-js": "^1.8.17",
    "@codemirror/state": "^6.4.1",
    "@codemirror/view": "^6.28.0",
    "@codemirror/commands": "^6.6.0",
    "@codemirror/lang-markdown": "^6.2.5",
    "@codemirror/language-data": "^6.4.1"
  },
  "devDependencies": {
    "vite": "^5.3.1",
    "vite-plugin-solid": "^2.10.2",
    "typescript": "^5.5.2"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "useDefineForClassFields": true,
    "module": "ESNext",
    "lib": ["ESNext", "DOM"],
    "moduleDetection": "force",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "noEmit": true,
    "isolatedModules": true,
    "strict": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
});
```

- [ ] **Step 4: Create `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Cubical Design System</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create `src/main.tsx`**

```tsx
import { render } from 'solid-js/web';
import App from './App';

render(() => <App />, document.getElementById('root')!);
```

- [ ] **Step 6: Create `src/App.tsx`**

```tsx
const App = () => {
  return <div>Cubical</div>;
};

export default App;
```

- [ ] **Step 7: Create `.gitignore`**

```
node_modules
dist
.DS_Store
```

- [ ] **Step 8: Install and verify**

Run: `npm install`
Run: `npm run typecheck` — expect no errors.
Run: `npm run dev &` then `curl -s http://localhost:5173 | grep -o '<div id="root">'` — expect a match, confirming the dev server serves the shell. Stop the dev server after checking.

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json vite.config.ts index.html src .gitignore
git commit -m "Scaffold Vite + Solid + TypeScript project"
```

---

### Task 2: Token system

**Files:**
- Create: `src/styles/tokens.css`

**Interfaces:**
- Produces: every `--c-*`, `--space-*`, `--radius-*`, `--text-*`, `--font-*`, `--weight-*`, `--tracking-*`, `--leading-*`, `--duration-*`, `--ease-standard`, `--shadow-*`, `--scrim`, `--row-height` custom property used by every later task.

- [ ] **Step 1: Write `src/styles/tokens.css`**

```css
:root {
  /* Spacing (4px base) */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-7: 28px;
  --space-8: 32px;

  /* Radii */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;
  --radius-full: 9999px;

  /* Type ramp (12 -> 30px, 7 steps) */
  --text-xs: 12px;
  --text-sm: 14px;
  --text-base: 16px;
  --text-lg: 18px;
  --text-xl: 20px;
  --text-2xl: 24px;
  --text-3xl: 30px;

  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "Roboto Mono", Menlo, Consolas, monospace;

  --weight-body: 400;
  --weight-heading: 700;
  --tracking-heading: -0.01em;
  --tracking-eyebrow: 0.08em;
  --leading-body: 1.5;
  --leading-tight: 1.2;

  /* Motion */
  --duration-state: 120ms;
  --duration-surface: 200ms;
  --ease-standard: cubic-bezier(0.2, 0, 0, 1);

  /* Elevation */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.12);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.16);
  --shadow-lg: 0 12px 32px rgba(0, 0, 0, 0.2);
  --scrim: rgba(0, 0, 0, 0.5);

  /* File-tree row */
  --row-height: 32px;
}

/* Light theme (default) */
:root,
[data-theme="light"] {
  --c-bg-primary: #faf8f3;
  --c-bg-secondary: #f3f0e8;
  --c-bg-tertiary: #ebe7db;
  --c-fg-primary: #1f1c15;
  --c-fg-secondary: #5c574a;
  --c-fg-muted: #8a8374;
  --c-border-subtle: #e3ded0;
  --c-border-strong: #b9b29d;
  --c-accent: #4f6d68;
  --c-accent-contrast: #faf8f3;
  --c-focus-ring: #4f6d68;
  --c-success: #4f7d4a;
  --c-warning: #b8862f;
  --c-error: #b3452f;
}

[data-theme="dark"] {
  --c-bg-primary: #181610;
  --c-bg-secondary: #201d16;
  --c-bg-tertiary: #2a2620;
  --c-fg-primary: #f2ede2;
  --c-fg-secondary: #b4ac9b;
  --c-fg-muted: #7d7666;
  --c-border-subtle: #302c23;
  --c-border-strong: #4a4436;
  --c-accent: #7fa39c;
  --c-accent-contrast: #14201d;
  --c-focus-ring: #7fa39c;
  --c-success: #7fb473;
  --c-warning: #d9a54c;
  --c-error: #d97a5c;
}

[data-theme="high-contrast"] {
  --c-bg-primary: #ffffff;
  --c-bg-secondary: #ffffff;
  --c-bg-tertiary: #d8d8d8;
  --c-fg-primary: #000000;
  --c-fg-secondary: #000000;
  --c-fg-muted: #3d3d3d;
  --c-border-subtle: #000000;
  --c-border-strong: #000000;
  --c-accent: #005f56;
  --c-accent-contrast: #ffffff;
  --c-focus-ring: #005f56;
  --c-success: #006400;
  --c-warning: #8a5a00;
  --c-error: #b00000;
}

@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-state: 0ms;
    --duration-surface: 0ms;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/styles/tokens.css
git commit -m "Add design token system with light/dark/high-contrast themes"
```

---

### Task 3: Base and layout CSS

**Files:**
- Create: `src/styles/base.css`
- Create: `src/styles/layout.css`
- Modify: `src/main.tsx` (import the three style files)

**Interfaces:**
- Consumes: tokens from Task 2.
- Produces: `.eyebrow`, `.stack`, `.row`, `.scroll-y`, `.divided-list`, `.app-shell` utility classes used throughout.

- [ ] **Step 1: Write `src/styles/base.css`**

```css
*, *::before, *::after {
  box-sizing: border-box;
}

html, body {
  margin: 0;
  padding: 0;
  height: 100%;
}

body {
  background: var(--c-bg-primary);
  color: var(--c-fg-primary);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  font-weight: var(--weight-body);
  line-height: var(--leading-body);
  -webkit-font-smoothing: antialiased;
}

h1, h2, h3, h4, h5, h6 {
  font-weight: var(--weight-heading);
  letter-spacing: var(--tracking-heading);
  line-height: var(--leading-tight);
  margin: 0;
}

code, kbd, samp, pre {
  font-family: var(--font-mono);
}

button, input, textarea, select {
  font: inherit;
  color: inherit;
}

button {
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
}

a {
  color: inherit;
}

:focus {
  outline: none;
}

:focus-visible {
  outline: 2px solid var(--c-focus-ring);
  outline-offset: 2px;
}

.eyebrow {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: var(--tracking-eyebrow);
  color: var(--c-fg-secondary);
}
```

- [ ] **Step 2: Write `src/styles/layout.css`**

```css
.stack {
  display: flex;
  flex-direction: column;
}

.row {
  display: flex;
  flex-direction: row;
  align-items: center;
}

.scroll-y {
  overflow-y: auto;
  overflow-x: hidden;
}

.divided-list > * + * {
  border-top: 1px solid var(--c-border-subtle);
}

.app-shell {
  display: grid;
  grid-template-rows: auto 1fr;
  height: 100vh;
  width: 100vw;
  background: var(--c-bg-primary);
}
```

- [ ] **Step 3: Import styles in `src/main.tsx`**

```tsx
import { render } from 'solid-js/web';
import App from './App';
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';

render(() => <App />, document.getElementById('root')!);
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect no errors.
Run: `npm run dev &`, then `curl -s http://localhost:5173/src/styles/tokens.css | grep -q -- '--c-accent'` — expect a match. Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add src/styles/base.css src/styles/layout.css src/main.tsx
git commit -m "Add base reset and layout utility CSS"
```

---

### Task 4: App shell, theme signal, screen switcher

**Files:**
- Create: `src/theme.ts`
- Create: `src/App.css`
- Create: `src/screens/Gallery/Gallery.tsx`
- Create: `src/screens/Gallery/Gallery.css`
- Create: `src/screens/Workspace/Workspace.tsx`
- Create: `src/screens/EmptyVault/EmptyVault.tsx`
- Create: `src/screens/Settings/Settings.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Produces: `theme()`/`applyTheme()` from `src/theme.ts`; `screen()`/`setScreen()` exported from `src/App.tsx`, used by every screen task from here on.

- [ ] **Step 1: Write `src/theme.ts`**

```ts
import { createSignal } from 'solid-js';

export type ThemeName = 'light' | 'dark' | 'high-contrast';

const stored = (typeof localStorage !== 'undefined' && localStorage.getItem('cubical-theme')) as ThemeName | null;

export const [theme, setThemeSignal] = createSignal<ThemeName>(stored ?? 'light');

export const applyTheme = (name: ThemeName) => {
  setThemeSignal(name);
  document.documentElement.setAttribute('data-theme', name);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('cubical-theme', name);
  }
};
```

- [ ] **Step 2: Write minimal screen stubs**

`src/screens/Gallery/Gallery.tsx`:

```tsx
import './Gallery.css';

const Gallery = () => {
  return (
    <div class="gallery stack scroll-y">
      <h1>Component gallery</h1>
    </div>
  );
};

export default Gallery;
```

`src/screens/Gallery/Gallery.css`:

```css
.gallery {
  padding: var(--space-6);
  gap: var(--space-8);
  height: 100%;
}

.gallery-section {
  gap: var(--space-3);
}

.gallery-row {
  gap: var(--space-3);
  align-items: center;
  flex-wrap: wrap;
}
```

`src/screens/Workspace/Workspace.tsx`:

```tsx
const Workspace = () => {
  return (
    <div style={{ padding: 'var(--space-6)' }}>
      <h1>Workspace</h1>
    </div>
  );
};

export default Workspace;
```

`src/screens/EmptyVault/EmptyVault.tsx`:

```tsx
const EmptyVault = () => {
  return (
    <div style={{ padding: 'var(--space-6)' }}>
      <h1>Empty vault</h1>
    </div>
  );
};

export default EmptyVault;
```

`src/screens/Settings/Settings.tsx`:

```tsx
const Settings = () => {
  return (
    <div style={{ padding: 'var(--space-6)' }}>
      <h1>Settings</h1>
    </div>
  );
};

export default Settings;
```

- [ ] **Step 3: Write `src/App.css`**

```css
.dev-switcher {
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  background: var(--c-bg-secondary);
  border-bottom: 1px solid var(--c-border-subtle);
}

.dev-switcher-btn {
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--c-fg-secondary);
  transition: background var(--duration-state) var(--ease-standard), color var(--duration-state) var(--ease-standard);
}

.dev-switcher-btn:hover {
  background: var(--c-bg-tertiary);
  color: var(--c-fg-primary);
}

.dev-switcher-btn.active {
  background: var(--c-accent);
  color: var(--c-accent-contrast);
}
```

- [ ] **Step 4: Write `src/App.tsx`**

```tsx
import { createSignal, onMount, Show } from 'solid-js';
import { theme, applyTheme } from './theme';
import Gallery from './screens/Gallery/Gallery';
import Workspace from './screens/Workspace/Workspace';
import EmptyVault from './screens/EmptyVault/EmptyVault';
import Settings from './screens/Settings/Settings';
import './App.css';

export type ScreenName = 'workspace' | 'empty-vault' | 'settings' | 'gallery';

export const [screen, setScreen] = createSignal<ScreenName>('gallery');

const SCREENS: { id: ScreenName; label: string }[] = [
  { id: 'gallery', label: 'Gallery' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'empty-vault', label: 'Empty vault' },
  { id: 'settings', label: 'Settings' },
];

const App = () => {
  onMount(() => applyTheme(theme()));

  return (
    <div class="app-shell">
      <nav class="dev-switcher row">
        {SCREENS.map((s) => (
          <button
            class="dev-switcher-btn eyebrow"
            classList={{ active: screen() === s.id }}
            onClick={() => setScreen(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <Show when={screen() === 'gallery'}><Gallery /></Show>
      <Show when={screen() === 'workspace'}><Workspace /></Show>
      <Show when={screen() === 'empty-vault'}><EmptyVault /></Show>
      <Show when={screen() === 'settings'}><Settings /></Show>
    </div>
  );
};

export default App;
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck` — expect no errors.
Run: `npm run dev &`. In a browser, open the printed URL, confirm the dev-switcher bar shows four tabs, "Gallery" is active by default, and clicking each tab swaps the visible screen. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add src/theme.ts src/App.css src/App.tsx src/screens
git commit -m "Add app shell, theme signal, and screen switcher"
```

---

### Task 5: Brand — CubeMark

**Files:**
- Create: `src/components/brand/CubeMark/CubeMark.tsx`
- Modify: `src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Produces: `CubeMark({ size?: number })`.

- [ ] **Step 1: Write `src/components/brand/CubeMark/CubeMark.tsx`**

```tsx
export interface CubeMarkProps {
  size?: number;
}

const CubeMark = (props: CubeMarkProps) => {
  const size = () => props.size ?? 24;
  return (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linejoin="round"
      stroke-linecap="round"
    >
      <path d="M12 2.5l8.5 4.9v9.2L12 21.5l-8.5-4.9V7.4z" />
      <path d="M3.5 7.4L12 12.3l8.5-4.9" />
      <path d="M12 12.3v9.2" />
    </svg>
  );
};

export default CubeMark;
```

- [ ] **Step 2: Add to Gallery**

In `src/screens/Gallery/Gallery.tsx`, add the import and insert a section before the closing `</div>`:

```tsx
import CubeMark from '../../components/brand/CubeMark/CubeMark';
```

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Brand — CubeMark</div>
        <div class="gallery-row row">
          <CubeMark size={16} />
          <CubeMark size={24} />
          <CubeMark size={40} />
        </div>
      </section>
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, open the Gallery tab and confirm three cube marks render at increasing sizes using the current theme's foreground color.

- [ ] **Step 4: Commit**

```bash
git add src/components/brand src/screens/Gallery/Gallery.tsx
git commit -m "Add CubeMark brand component"
```

---

### Task 6: Forms — Button

**Files:**
- Create: `src/components/forms/Button/Button.tsx`
- Create: `src/components/forms/Button/Button.css`
- Modify: `src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Produces: `Button` (signature in Component & prop reference).

- [ ] **Step 1: Write `src/components/forms/Button/Button.tsx`**

```tsx
import { JSX } from 'solid-js';
import './Button.css';

export interface ButtonProps {
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  type?: 'button' | 'submit';
  onClick?: (e: MouseEvent) => void;
  children: JSX.Element;
}

const Button = (props: ButtonProps) => {
  return (
    <button
      type={props.type ?? 'button'}
      class="btn"
      classList={{
        primary: (props.variant ?? 'secondary') === 'primary',
        secondary: (props.variant ?? 'secondary') === 'secondary',
      }}
      disabled={props.disabled}
      onClick={(e) => props.onClick?.(e)}
    >
      {props.children}
    </button>
  );
};

export default Button;
```

- [ ] **Step 2: Write `src/components/forms/Button/Button.css`**

```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 32px;
  padding: 0 var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  font-weight: var(--weight-body);
  border: 1px solid transparent;
  transition: background var(--duration-state) var(--ease-standard),
    border-color var(--duration-state) var(--ease-standard),
    color var(--duration-state) var(--ease-standard);
}

.btn.primary {
  background: var(--c-accent);
  color: var(--c-accent-contrast);
}

.btn.primary:hover:not(:disabled) {
  box-shadow: var(--shadow-sm);
}

.btn.secondary {
  background: transparent;
  color: var(--c-fg-primary);
  border-color: var(--c-border-strong);
}

.btn.secondary:hover:not(:disabled) {
  background: var(--c-bg-tertiary);
}

.btn:disabled {
  opacity: 0.5;
  cursor: default;
}
```

- [ ] **Step 3: Add to Gallery**

Add import:

```tsx
import Button from '../../components/forms/Button/Button';
```

Insert section:

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Forms — Button</div>
        <div class="gallery-row row">
          <Button variant="secondary">Secondary</Button>
          <Button variant="primary">Primary</Button>
          <Button variant="secondary" disabled>Disabled</Button>
        </div>
      </section>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, confirm the three buttons render, hovering Secondary shows a `bg-tertiary` fill, Primary is accent-filled, Disabled is at reduced opacity and unclickable, and tabbing to each shows the focus ring.

- [ ] **Step 5: Commit**

```bash
git add src/components/forms/Button src/screens/Gallery/Gallery.tsx
git commit -m "Add Button component"
```

---

### Task 7: Forms — IconButton

**Files:**
- Create: `src/components/forms/IconButton/IconButton.tsx`
- Create: `src/components/forms/IconButton/IconButton.css`
- Modify: `src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Produces: `IconButton` (signature above).

- [ ] **Step 1: Write `src/components/forms/IconButton/IconButton.tsx`**

```tsx
import { JSX } from 'solid-js';
import './IconButton.css';

export interface IconButtonProps {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  children: JSX.Element;
}

const IconButton = (props: IconButtonProps) => {
  return (
    <button
      type="button"
      class="icon-btn"
      classList={{ active: props.active }}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={(e) => props.onClick?.(e)}
    >
      {props.children}
    </button>
  );
};

export default IconButton;
```

- [ ] **Step 2: Write `src/components/forms/IconButton/IconButton.css`**

```css
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.9rem;
  height: 1.9rem;
  border-radius: var(--radius-sm);
  color: var(--c-fg-secondary);
  background: transparent;
  line-height: 1;
  transition: background var(--duration-state) var(--ease-standard),
    color var(--duration-state) var(--ease-standard);
}

.icon-btn:hover:not(:disabled) {
  background: var(--c-bg-tertiary);
  color: var(--c-fg-primary);
}

.icon-btn.active {
  background: var(--c-accent);
  color: var(--c-accent-contrast);
}

.icon-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
```

- [ ] **Step 3: Add to Gallery**

Add import:

```tsx
import IconButton from '../../components/forms/IconButton/IconButton';
```

Insert section:

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Forms — IconButton</div>
        <div class="gallery-row row">
          <IconButton label="Resting">⚙</IconButton>
          <IconButton label="Active" active>⚙</IconButton>
          <IconButton label="Disabled" disabled>⚙</IconButton>
        </div>
      </section>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, confirm resting/hover/active/disabled states match the spec (hover = `bg-tertiary` fill, active = accent fill).

- [ ] **Step 5: Commit**

```bash
git add src/components/forms/IconButton src/screens/Gallery/Gallery.tsx
git commit -m "Add IconButton component"
```

---

### Task 8: Forms — TextInput

**Files:**
- Create: `src/components/forms/TextInput/TextInput.tsx`
- Create: `src/components/forms/TextInput/TextInput.css`
- Modify: `src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Produces: `TextInput` (signature above).

- [ ] **Step 1: Write `src/components/forms/TextInput/TextInput.tsx`**

```tsx
import './TextInput.css';

export interface TextInputProps {
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
}

const TextInput = (props: TextInputProps) => {
  return (
    <input
      class="text-input"
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
  );
};

export default TextInput;
```

- [ ] **Step 2: Write `src/components/forms/TextInput/TextInput.css`**

```css
.text-input {
  height: 32px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--c-border-subtle);
  background: var(--c-bg-primary);
  color: var(--c-fg-primary);
  font-size: var(--text-sm);
  width: 100%;
  transition: border-color var(--duration-state) var(--ease-standard);
}

.text-input::placeholder {
  color: var(--c-fg-muted);
}

.text-input:focus-visible {
  border-color: var(--c-accent);
  outline: 2px solid var(--c-focus-ring);
  outline-offset: 2px;
}

.text-input:disabled {
  opacity: 0.5;
}
```

- [ ] **Step 3: Add to Gallery**

Add imports (extend the existing `solid-js` import with `createSignal` if not already present):

```tsx
import { createSignal } from 'solid-js';
import TextInput from '../../components/forms/TextInput/TextInput';
```

Add a signal inside the `Gallery` component body, above the `return`:

```tsx
  const [textInputValue, setTextInputValue] = createSignal('');
```

Insert section:

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Forms — TextInput</div>
        <div class="gallery-row row">
          <TextInput value={textInputValue()} onInput={setTextInputValue} placeholder="Search notes…" />
          <TextInput value="" onInput={() => {}} placeholder="Disabled" disabled />
        </div>
      </section>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, type into the first input and confirm it updates; confirm the placeholder is `fg-muted`, focus shows the accent border + ring, and the second input is visibly disabled.

- [ ] **Step 5: Commit**

```bash
git add src/components/forms/TextInput src/screens/Gallery/Gallery.tsx
git commit -m "Add TextInput component"
```

---

### Task 9: Forms — Toggle

**Files:**
- Create: `src/components/forms/Toggle/Toggle.tsx`
- Create: `src/components/forms/Toggle/Toggle.css`
- Modify: `src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Produces: `Toggle` (signature above).

- [ ] **Step 1: Write `src/components/forms/Toggle/Toggle.tsx`**

```tsx
import './Toggle.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}

const Toggle = (props: ToggleProps) => {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      class="toggle"
      classList={{ checked: props.checked }}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="toggle-thumb" />
    </button>
  );
};

export default Toggle;
```

- [ ] **Step 2: Write `src/components/forms/Toggle/Toggle.css`**

```css
.toggle {
  width: 36px;
  height: 20px;
  border-radius: var(--radius-full);
  background: var(--c-bg-tertiary);
  border: 1px solid var(--c-border-strong);
  position: relative;
  transition: background var(--duration-state) var(--ease-standard);
}

.toggle.checked {
  background: var(--c-accent);
  border-color: var(--c-accent);
}

.toggle:disabled {
  opacity: 0.5;
  cursor: default;
}

.toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: var(--radius-full);
  background: var(--c-bg-primary);
  transition: transform var(--duration-state) var(--ease-standard);
}

.toggle.checked .toggle-thumb {
  transform: translateX(16px);
}
```

- [ ] **Step 3: Add to Gallery**

Add import:

```tsx
import Toggle from '../../components/forms/Toggle/Toggle';
```

Add a signal:

```tsx
  const [toggleValue, setToggleValue] = createSignal(true);
```

Insert section:

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Forms — Toggle</div>
        <div class="gallery-row row">
          <Toggle checked={toggleValue()} onChange={setToggleValue} label="Enable feature" />
          <Toggle checked={false} onChange={() => {}} disabled label="Disabled" />
        </div>
      </section>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, click the first toggle and confirm the thumb slides with an accent-filled track; confirm the second toggle is visibly disabled.

- [ ] **Step 5: Commit**

```bash
git add src/components/forms/Toggle src/screens/Gallery/Gallery.tsx
git commit -m "Add Toggle component"
```

---

### Task 10: Forms — SegmentedControl

**Files:**
- Create: `src/components/forms/SegmentedControl/SegmentedControl.tsx`
- Create: `src/components/forms/SegmentedControl/SegmentedControl.css`
- Modify: `src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Produces: `SegmentedControl` (signature above), reused by RightSidebar (Task 22) and Settings (Task 24).

- [ ] **Step 1: Write `src/components/forms/SegmentedControl/SegmentedControl.tsx`**

```tsx
import { For } from 'solid-js';
import './SegmentedControl.css';

export interface SegmentedOption {
  label: string;
  value: string;
}

export interface SegmentedControlProps {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
}

const SegmentedControl = (props: SegmentedControlProps) => {
  return (
    <div class="segmented-control row" role="tablist">
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            role="tab"
            aria-selected={props.value === option.value}
            class="segmented-option"
            classList={{ selected: props.value === option.value }}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
};

export default SegmentedControl;
```

- [ ] **Step 2: Write `src/components/forms/SegmentedControl/SegmentedControl.css`**

```css
.segmented-control {
  gap: var(--space-5);
  border-bottom: 1px solid var(--c-border-subtle);
}

.segmented-option {
  padding: var(--space-2) 0;
  color: var(--c-fg-secondary);
  font-size: var(--text-sm);
  border-bottom: 2px solid transparent;
  transition: color var(--duration-state) var(--ease-standard), border-color var(--duration-state) var(--ease-standard);
}

.segmented-option:hover {
  color: var(--c-fg-primary);
}

.segmented-option.selected {
  color: var(--c-fg-primary);
  border-bottom-color: var(--c-accent);
}
```

- [ ] **Step 3: Add to Gallery**

Add import:

```tsx
import SegmentedControl from '../../components/forms/SegmentedControl/SegmentedControl';
```

Add a signal:

```tsx
  const [segmentValue, setSegmentValue] = createSignal('backlinks');
```

Insert section:

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Forms — SegmentedControl</div>
        <SegmentedControl
          value={segmentValue()}
          onChange={setSegmentValue}
          options={[
            { label: 'Backlinks', value: 'backlinks' },
            { label: 'Mentions', value: 'mentions' },
          ]}
        />
      </section>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, click each tab and confirm the 2px accent underline moves to the selected tab.

- [ ] **Step 5: Commit**

```bash
git add src/components/forms/SegmentedControl src/screens/Gallery/Gallery.tsx
git commit -m "Add SegmentedControl component"
```

---

### Task 11: Feedback — Badge

**Files:**
- Create: `src/components/feedback/Badge/Badge.tsx`
- Create: `src/components/feedback/Badge/Badge.css`
- Modify: `src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Produces: `Badge` (signature above).

- [ ] **Step 1: Write `src/components/feedback/Badge/Badge.tsx`**

```tsx
import { JSX } from 'solid-js';
import './Badge.css';

export type Tone = 'neutral' | 'success' | 'warning' | 'error';

export interface BadgeProps {
  tone?: Tone;
  children: JSX.Element;
}

const Badge = (props: BadgeProps) => {
  return (
    <span class="badge" classList={{ [props.tone ?? 'neutral']: true }}>
      {props.children}
    </span>
  );
};

export default Badge;
```

- [ ] **Step 2: Write `src/components/feedback/Badge/Badge.css`**

```css
.badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1;
}

.badge.neutral {
  background: var(--c-bg-tertiary);
  color: var(--c-fg-secondary);
}

.badge.success {
  background: color-mix(in srgb, var(--c-success) 16%, transparent);
  color: var(--c-success);
}

.badge.warning {
  background: color-mix(in srgb, var(--c-warning) 16%, transparent);
  color: var(--c-warning);
}

.badge.error {
  background: color-mix(in srgb, var(--c-error) 16%, transparent);
  color: var(--c-error);
}
```

- [ ] **Step 3: Add to Gallery**

Add import:

```tsx
import Badge from '../../components/feedback/Badge/Badge';
```

Insert section:

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Feedback — Badge</div>
        <div class="gallery-row row">
          <Badge>Neutral</Badge>
          <Badge tone="success">Success</Badge>
          <Badge tone="warning">Warning</Badge>
          <Badge tone="error">Error</Badge>
        </div>
      </section>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, confirm four badges render with distinct neutral/success/warning/error colors.

- [ ] **Step 5: Commit**

```bash
git add src/components/feedback/Badge src/screens/Gallery/Gallery.tsx
git commit -m "Add Badge component"
```

---

### Task 12: Feedback — Callout

**Files:**
- Create: `src/components/feedback/Callout/Callout.tsx`
- Create: `src/components/feedback/Callout/Callout.css`
- Modify: `src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Produces: `Callout` (signature above).

- [ ] **Step 1: Write `src/components/feedback/Callout/Callout.tsx`**

```tsx
import { JSX, Show } from 'solid-js';
import './Callout.css';

export type Tone = 'neutral' | 'success' | 'warning' | 'error';

export interface CalloutProps {
  tone?: Tone;
  title?: string;
  children: JSX.Element;
}

const Callout = (props: CalloutProps) => {
  return (
    <div class="callout" classList={{ [props.tone ?? 'neutral']: true }}>
      <Show when={props.title}>
        <div class="callout-title">{props.title}</div>
      </Show>
      <div class="callout-body">{props.children}</div>
    </div>
  );
};

export default Callout;
```

- [ ] **Step 2: Write `src/components/feedback/Callout/Callout.css`**

```css
.callout {
  padding: var(--space-4);
  background: var(--c-bg-secondary);
  border-left: 2px solid var(--c-border-strong);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
}

.callout-title {
  font-weight: var(--weight-heading);
  margin-bottom: var(--space-1);
}

.callout.neutral { border-left-color: var(--c-border-strong); }
.callout.success { border-left-color: var(--c-success); }
.callout.warning { border-left-color: var(--c-warning); }
.callout.error { border-left-color: var(--c-error); }
```

- [ ] **Step 3: Add to Gallery**

Add import:

```tsx
import Callout from '../../components/feedback/Callout/Callout';
```

Insert section:

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Feedback — Callout</div>
        <div class="stack" style={{ gap: 'var(--space-3)' }}>
          <Callout title="Note">Neutral callout copy.</Callout>
          <Callout tone="success" title="Indexed">Vault indexed — 1,204 notes.</Callout>
          <Callout tone="warning" title="Unresolved link">This note has 2 broken wiki-links.</Callout>
          <Callout tone="error" title="Write failed">Could not save — disk full.</Callout>
        </div>
      </section>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, confirm each callout shows the correct left-border color per tone and no nested boxes/double borders appear.

- [ ] **Step 5: Commit**

```bash
git add src/components/feedback/Callout src/screens/Gallery/Gallery.tsx
git commit -m "Add Callout component"
```

---

### Task 13: Feedback — Toast

**Files:**
- Create: `src/components/feedback/Toast/Toast.tsx`
- Create: `src/components/feedback/Toast/Toast.css`
- Modify: `src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Produces: `Toast` (signature above).

- [ ] **Step 1: Write `src/components/feedback/Toast/Toast.tsx`**

```tsx
import { onCleanup, onMount } from 'solid-js';
import './Toast.css';

export type Tone = 'neutral' | 'success' | 'warning' | 'error';

export interface ToastProps {
  tone?: Tone;
  message: string;
  onDismiss: () => void;
  autoDismissMs?: number;
}

const Toast = (props: ToastProps) => {
  onMount(() => {
    const ms = props.autoDismissMs ?? 4000;
    const id = setTimeout(() => props.onDismiss(), ms);
    onCleanup(() => clearTimeout(id));
  });

  return (
    <div class="toast" classList={{ [props.tone ?? 'neutral']: true }} role="status">
      <span>{props.message}</span>
      <button type="button" class="toast-dismiss" aria-label="Dismiss" onClick={() => props.onDismiss()}>
        ×
      </button>
    </div>
  );
};

export default Toast;
```

- [ ] **Step 2: Write `src/components/feedback/Toast/Toast.css`**

```css
.toast {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--c-bg-secondary);
  border: 1px solid var(--c-border-subtle);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  font-size: var(--text-sm);
  color: var(--c-fg-primary);
  animation: toast-in var(--duration-surface) var(--ease-standard);
}

.toast.success { border-left: 2px solid var(--c-success); }
.toast.warning { border-left: 2px solid var(--c-warning); }
.toast.error { border-left: 2px solid var(--c-error); }

.toast-dismiss {
  margin-left: auto;
  color: var(--c-fg-secondary);
  line-height: 1;
}

.toast-dismiss:hover {
  color: var(--c-fg-primary);
}

@keyframes toast-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 3: Add to Gallery**

Add imports (extend existing `solid-js` import with `Show` if not already present):

```tsx
import { Show } from 'solid-js';
import Toast from '../../components/feedback/Toast/Toast';
```

Add a signal:

```tsx
  const [showToast, setShowToast] = createSignal(false);
```

Insert section:

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Feedback — Toast</div>
        <div class="gallery-row row">
          <Button variant="secondary" onClick={() => setShowToast(true)}>Trigger toast</Button>
        </div>
        <Show when={showToast()}>
          <Toast message="Vault indexed — 1,204 notes." tone="success" onDismiss={() => setShowToast(false)} />
        </Show>
      </section>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, click "Trigger toast", confirm it appears with a `shadow-md` elevation and either the × dismisses it or it auto-dismisses after 4 seconds.

- [ ] **Step 5: Commit**

```bash
git add src/components/feedback/Toast src/screens/Gallery/Gallery.tsx
git commit -m "Add Toast component"
```

---

### Task 14: Feedback — Tooltip

**Files:**
- Create: `src/components/feedback/Tooltip/Tooltip.tsx`
- Create: `src/components/feedback/Tooltip/Tooltip.css`
- Modify: `src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Produces: `Tooltip` (signature above).

- [ ] **Step 1: Write `src/components/feedback/Tooltip/Tooltip.tsx`**

```tsx
import { JSX, createSignal, Show } from 'solid-js';
import './Tooltip.css';

export interface TooltipProps {
  label: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  children: JSX.Element;
}

const Tooltip = (props: TooltipProps) => {
  const [visible, setVisible] = createSignal(false);

  return (
    <span
      class="tooltip-wrapper"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocusIn={() => setVisible(true)}
      onFocusOut={() => setVisible(false)}
    >
      {props.children}
      <Show when={visible()}>
        <span class="tooltip" classList={{ [props.placement ?? 'top']: true }} role="tooltip">
          {props.label}
        </span>
      </Show>
    </span>
  );
};

export default Tooltip;
```

- [ ] **Step 2: Write `src/components/feedback/Tooltip/Tooltip.css`**

```css
.tooltip-wrapper {
  position: relative;
  display: inline-flex;
}

.tooltip {
  position: absolute;
  z-index: 10;
  padding: var(--space-1) var(--space-2);
  background: var(--c-fg-primary);
  color: var(--c-bg-primary);
  font-size: var(--text-xs);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-sm);
  white-space: nowrap;
  animation: tooltip-in var(--duration-state) var(--ease-standard);
}

.tooltip.top { bottom: calc(100% + var(--space-2)); left: 50%; transform: translateX(-50%); }
.tooltip.bottom { top: calc(100% + var(--space-2)); left: 50%; transform: translateX(-50%); }
.tooltip.left { right: calc(100% + var(--space-2)); top: 50%; transform: translateY(-50%); }
.tooltip.right { left: calc(100% + var(--space-2)); top: 50%; transform: translateY(-50%); }

@keyframes tooltip-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
```

- [ ] **Step 3: Add to Gallery**

Add import:

```tsx
import Tooltip from '../../components/feedback/Tooltip/Tooltip';
```

Insert section:

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Feedback — Tooltip</div>
        <div class="gallery-row row">
          <Tooltip label="Reveal in file tree">
            <IconButton label="Reveal">⌄</IconButton>
          </Tooltip>
        </div>
      </section>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, hover and then keyboard-focus the icon button and confirm the tooltip appears above it both times.

- [ ] **Step 5: Commit**

```bash
git add src/components/feedback/Tooltip src/screens/Gallery/Gallery.tsx
git commit -m "Add Tooltip component"
```

---

### Task 15: Data — Tag

**Files:**
- Create: `src/components/data/Tag/Tag.tsx`
- Create: `src/components/data/Tag/Tag.css`
- Modify: `src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Produces: `Tag` (signature above).

- [ ] **Step 1: Write `src/components/data/Tag/Tag.tsx`**

```tsx
import './Tag.css';

export interface TagProps {
  label: string;
  resolved?: boolean;
  onClick?: () => void;
}

const Tag = (props: TagProps) => {
  return (
    <button type="button" class="tag" classList={{ resolved: props.resolved }} onClick={() => props.onClick?.()}>
      #{props.label}
    </button>
  );
};

export default Tag;
```

- [ ] **Step 2: Write `src/components/data/Tag/Tag.css`**

```css
.tag {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  background: var(--c-bg-tertiary);
  color: var(--c-fg-secondary);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  transition: color var(--duration-state) var(--ease-standard);
}

.tag:hover {
  color: var(--c-fg-primary);
}

.tag.resolved {
  color: var(--c-accent);
}
```

- [ ] **Step 3: Add to Gallery**

Add import:

```tsx
import Tag from '../../components/data/Tag/Tag';
```

Insert section:

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Data — Tag</div>
        <div class="gallery-row row">
          <Tag label="design" />
          <Tag label="cubical" resolved />
        </div>
      </section>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, confirm the resolved tag renders in accent color and the unresolved tag in `fg-secondary`.

- [ ] **Step 5: Commit**

```bash
git add src/components/data/Tag src/screens/Gallery/Gallery.tsx
git commit -m "Add Tag component"
```

---

### Task 16: Data — FileTreeRow (and FileIcon)

**Files:**
- Create: `src/components/data/FileTreeRow/FileIcon.tsx`
- Create: `src/components/data/FileTreeRow/FileTreeRow.tsx`
- Create: `src/components/data/FileTreeRow/FileTreeRow.css`
- Modify: `src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Produces: `FileIcon`, `FileTreeRow`, and the exported `FileKind` type (signatures above), reused by `src/screens/Workspace/FileTree.tsx` (Task 22) and `src/fixtures/vault.ts` (Task 21).

- [ ] **Step 1: Write `src/components/data/FileTreeRow/FileIcon.tsx`**

```tsx
export type FileKind = 'folder' | 'folder-open' | 'md' | 'txt' | 'png' | 'svg' | 'pdf' | 'code' | 'canvas' | 'broken';

const DOC = 'M3.5 1.5h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z';
const DOC_FOLD = 'M9.5 1.5v3h3';

export interface FileIconProps {
  kind: FileKind;
}

const FileIcon = (props: FileIconProps) => {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.3,
    'stroke-linejoin': 'round' as const,
    'stroke-linecap': 'round' as const,
  };

  if (props.kind === 'folder') {
    return (
      <svg {...common}>
        <path d="M1.5 3.5h4l1.2 1.5h7.3v7.5a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1v-9z" />
      </svg>
    );
  }
  if (props.kind === 'folder-open') {
    return (
      <svg {...common}>
        <path d="M1.5 5.5v-2a1 1 0 0 1 1-1h3l1.2 1.5h6.3a1 1 0 0 1 1 1v.5" />
        <path d="M1.5 5.5h12.5l-1.4 6.6a1 1 0 0 1-1 .9h-8.7a1 1 0 0 1-1-.8l-1.4-6.7z" />
      </svg>
    );
  }
  if (props.kind === 'md') {
    return (
      <svg {...common}>
        <path d={DOC} />
        <path d={DOC_FOLD} />
        <path d="M5 11.5v-3l1.5 1.8L8 8.5v3" />
        <path d="M9.5 8.5v3l1.3-1.3" />
      </svg>
    );
  }
  if (props.kind === 'txt') {
    return (
      <svg {...common}>
        <path d={DOC} />
        <path d={DOC_FOLD} />
        <path d="M5 8.5h6M5 10.5h6M5 12h4" />
      </svg>
    );
  }
  if (props.kind === 'png') {
    return (
      <svg {...common}>
        <path d={DOC} />
        <path d={DOC_FOLD} />
        <circle cx="6" cy="8.5" r="0.9" />
        <path d="M4.5 12.5l2.3-2.5 1.7 1.8 1-1.2 1.5 1.9" />
      </svg>
    );
  }
  if (props.kind === 'svg') {
    return (
      <svg {...common}>
        <path d={DOC} />
        <path d={DOC_FOLD} />
        <path d="M5 12.5l2-4 2 4M9.5 8.5l2 4" />
      </svg>
    );
  }
  if (props.kind === 'pdf') {
    return (
      <svg {...common}>
        <path d={DOC} />
        <path d={DOC_FOLD} />
        <path d="M5 12.5v-4h1a1 1 0 0 1 0 2h-1" />
        <path d="M8.3 12.5v-4h1.2M8.3 10.5h1" />
        <path d="M11 12.5v-4h1.2" />
      </svg>
    );
  }
  if (props.kind === 'code') {
    return (
      <svg {...common}>
        <path d={DOC} />
        <path d={DOC_FOLD} />
        <path d="M6 8.5l-1.5 2 1.5 2M9 8.5l1.5 2-1.5 2" />
      </svg>
    );
  }
  if (props.kind === 'canvas') {
    return (
      <svg {...common}>
        <path d={DOC} />
        <path d={DOC_FOLD} />
        <path d="M4.5 8.5h6v4h-6z" />
        <path d="M4.5 10.5h6M7.5 8.5v4" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d={DOC} />
      <path d={DOC_FOLD} />
      <path d="M6 8.5v1.4l1-.7 1 1.4-1 .7v1.2" />
    </svg>
  );
};

export default FileIcon;
```

- [ ] **Step 2: Write `src/components/data/FileTreeRow/FileTreeRow.tsx`**

```tsx
import { Show, createSignal } from 'solid-js';
import FileIcon, { FileKind } from './FileIcon';
import './FileTreeRow.css';

export interface FileTreeRowProps {
  name: string;
  depth: number;
  kind: FileKind;
  selected?: boolean;
  invalid?: boolean;
  renaming?: boolean;
  onClick?: () => void;
  onRenameCommit?: (name: string) => void;
}

const FileTreeRow = (props: FileTreeRowProps) => {
  const [draft, setDraft] = createSignal(props.name);

  return (
    <div
      class="file-tree-row row"
      classList={{ selected: props.selected, invalid: props.invalid }}
      style={{ 'padding-left': `calc(var(--space-3) + ${props.depth} * var(--space-5))` }}
      onClick={() => props.onClick?.()}
    >
      <FileIcon kind={props.kind} />
      <Show
        when={!props.renaming}
        fallback={
          <input
            class="file-tree-rename-input"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && props.onRenameCommit?.(draft())}
            onBlur={() => props.onRenameCommit?.(draft())}
            autofocus
          />
        }
      >
        <span class="file-tree-name">{props.name}</span>
      </Show>
      <Show when={props.invalid}>
        <span class="file-tree-warning" aria-label="Invalid">⚠</span>
      </Show>
    </div>
  );
};

export default FileTreeRow;
```

- [ ] **Step 3: Write `src/components/data/FileTreeRow/FileTreeRow.css`**

```css
.file-tree-row {
  height: var(--row-height);
  gap: var(--space-2);
  padding-right: var(--space-3);
  cursor: pointer;
  color: var(--c-fg-secondary);
  transition: background var(--duration-state) var(--ease-standard);
}

.file-tree-row:hover {
  background: var(--c-bg-tertiary);
}

.file-tree-row.selected {
  background: var(--c-bg-tertiary);
  color: var(--c-fg-primary);
  box-shadow: inset 2px 0 0 var(--c-accent);
}

.file-tree-name {
  font-size: var(--text-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-tree-row.invalid .file-tree-name {
  color: var(--c-warning);
  text-decoration: underline dotted;
}

.file-tree-warning {
  margin-left: auto;
  color: var(--c-warning);
  font-size: var(--text-xs);
}

.file-tree-rename-input {
  flex: 1;
  height: 22px;
  padding: 0 var(--space-1);
  border: 1px solid var(--c-accent);
  border-radius: var(--radius-sm);
  background: var(--c-bg-primary);
  color: var(--c-fg-primary);
  font-size: var(--text-sm);
}
```

- [ ] **Step 4: Add to Gallery**

Add import:

```tsx
import FileTreeRow from '../../components/data/FileTreeRow/FileTreeRow';
```

Insert section:

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Data — FileTreeRow</div>
        <div class="stack" style={{ width: '240px', border: '1px solid var(--c-border-subtle)' }}>
          <FileTreeRow name="Projects" depth={0} kind="folder" />
          <FileTreeRow name="Design notes.md" depth={1} kind="md" selected />
          <FileTreeRow name="Old spec.md" depth={1} kind="broken" invalid />
          <FileTreeRow name="moodboard.png" depth={0} kind="png" renaming onRenameCommit={() => {}} />
        </div>
      </section>
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, confirm: the folder row shows a folder icon; the selected row shows the `bg-tertiary` fill plus the 2px accent left rail; the invalid row shows the warning color, dotted underline, and ⚠; the renaming row shows an inline input with an accent border.

- [ ] **Step 6: Commit**

```bash
git add src/components/data/FileTreeRow src/screens/Gallery/Gallery.tsx
git commit -m "Add FileTreeRow and FileIcon components"
```

---

### Task 17: Data — BacklinkRow

**Files:**
- Create: `src/components/data/BacklinkRow/BacklinkRow.tsx`
- Create: `src/components/data/BacklinkRow/BacklinkRow.css`
- Modify: `src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Produces: `BacklinkRow` (signature above), reused by `src/screens/Workspace/RightSidebar.tsx` (Task 22).

- [ ] **Step 1: Write `src/components/data/BacklinkRow/BacklinkRow.tsx`**

```tsx
import { Show } from 'solid-js';
import './BacklinkRow.css';

export interface BacklinkRowProps {
  noteTitle: string;
  snippet: string;
  matchQuery?: string;
  onClick?: () => void;
}

interface SnippetPart {
  text: string;
  match: boolean;
}

const highlight = (snippet: string, query?: string): SnippetPart[] => {
  if (!query) return [{ text: snippet, match: false }];
  const idx = snippet.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return [{ text: snippet, match: false }];
  return [
    { text: snippet.slice(0, idx), match: false },
    { text: snippet.slice(idx, idx + query.length), match: true },
    { text: snippet.slice(idx + query.length), match: false },
  ];
};

const BacklinkRow = (props: BacklinkRowProps) => {
  return (
    <button type="button" class="backlink-row stack" onClick={() => props.onClick?.()}>
      <span class="backlink-title">{props.noteTitle}</span>
      <span class="backlink-snippet">
        {highlight(props.snippet, props.matchQuery).map((part) => (
          <Show when={part.match} fallback={<>{part.text}</>}>
            <mark>{part.text}</mark>
          </Show>
        ))}
      </span>
    </button>
  );
};

export default BacklinkRow;
```

- [ ] **Step 2: Write `src/components/data/BacklinkRow/BacklinkRow.css`**

```css
.backlink-row {
  width: 100%;
  text-align: left;
  gap: var(--space-1);
  padding: var(--space-3) var(--space-4);
  transition: background var(--duration-state) var(--ease-standard);
}

.backlink-row:hover {
  background: var(--c-bg-tertiary);
}

.backlink-title {
  font-size: var(--text-sm);
  font-weight: var(--weight-heading);
  color: var(--c-fg-primary);
}

.backlink-snippet {
  font-size: var(--text-xs);
  color: var(--c-fg-secondary);
}

.backlink-snippet mark {
  background: var(--c-accent);
  color: var(--c-accent-contrast);
  border-radius: 2px;
  padding: 0 1px;
}
```

- [ ] **Step 3: Add to Gallery**

Add import:

```tsx
import BacklinkRow from '../../components/data/BacklinkRow/BacklinkRow';
```

Insert section:

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Data — BacklinkRow</div>
        <div class="stack divided-list" style={{ width: '320px', border: '1px solid var(--c-border-subtle)' }}>
          <BacklinkRow noteTitle="Cubical roadmap" snippet="Design notes cover the accent-as-state rule in depth." matchQuery="accent" />
          <BacklinkRow noteTitle="2026-07-12" snippet="Reviewed design notes before standup." />
        </div>
      </section>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, confirm the two rows are separated by a hairline divider and the word "accent" in the first row is highlighted with an accent `<mark>` fill.

- [ ] **Step 5: Commit**

```bash
git add src/components/data/BacklinkRow src/screens/Gallery/Gallery.tsx
git commit -m "Add BacklinkRow component"
```

---

### Task 18: Overlay — Menu

**Files:**
- Create: `src/components/overlay/Menu/Menu.tsx`
- Create: `src/components/overlay/Menu/Menu.css`
- Modify: `src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Produces: `Menu`, `MenuItem` (signature above).

- [ ] **Step 1: Write `src/components/overlay/Menu/Menu.tsx`**

```tsx
import { For } from 'solid-js';
import './Menu.css';

export interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuProps {
  items: MenuItem[];
}

const Menu = (props: MenuProps) => {
  return (
    <div class="menu stack" role="menu">
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            role="menuitem"
            class="menu-item row"
            disabled={item.disabled}
            onClick={() => item.onSelect()}
          >
            <span>{item.label}</span>
            {item.shortcut && <span class="menu-shortcut">{item.shortcut}</span>}
          </button>
        )}
      </For>
    </div>
  );
};

export default Menu;
```

- [ ] **Step 2: Write `src/components/overlay/Menu/Menu.css`**

```css
.menu {
  min-width: 200px;
  padding: var(--space-1);
  background: var(--c-bg-secondary);
  border: 1px solid var(--c-border-subtle);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}

.menu-item {
  justify-content: space-between;
  height: 28px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--c-fg-primary);
  transition: background var(--duration-state) var(--ease-standard);
}

.menu-item:hover:not(:disabled) {
  background: var(--c-bg-tertiary);
}

.menu-item:disabled {
  opacity: 0.5;
  cursor: default;
}

.menu-shortcut {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--c-fg-muted);
}
```

- [ ] **Step 3: Add to Gallery**

Add import:

```tsx
import Menu from '../../components/overlay/Menu/Menu';
```

Insert section:

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Overlay — Menu</div>
        <Menu
          items={[
            { id: 'rename', label: 'Rename…', shortcut: '⌘R', onSelect: () => {} },
            { id: 'delete', label: 'Delete', onSelect: () => {} },
            { id: 'reveal', label: 'Reveal in file tree', disabled: true, onSelect: () => {} },
          ]}
        />
      </section>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, confirm the menu has a `shadow-md` elevation, hovering an enabled item shows `bg-tertiary`, and the disabled item is inert.

- [ ] **Step 5: Commit**

```bash
git add src/components/overlay/Menu src/screens/Gallery/Gallery.tsx
git commit -m "Add Menu component"
```

---

### Task 19: Overlay — Modal

**Files:**
- Create: `src/components/overlay/Modal/Modal.tsx`
- Create: `src/components/overlay/Modal/Modal.css`
- Modify: `src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Produces: `Modal` (signature above), reused by `CommandPalette` (Task 20).

- [ ] **Step 1: Write `src/components/overlay/Modal/Modal.tsx`**

```tsx
import { JSX, Show, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import './Modal.css';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: JSX.Element;
}

const Modal = (props: ModalProps) => {
  const handleKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') props.onClose();
  };

  onMount(() => document.addEventListener('keydown', handleKey));
  onCleanup(() => document.removeEventListener('keydown', handleKey));

  return (
    <Show when={props.open}>
      <Portal>
        <div class="modal-scrim" onClick={() => props.onClose()}>
          <div class="modal-panel stack" onClick={(e) => e.stopPropagation()}>
            <Show when={props.title}>
              <div class="modal-title">{props.title}</div>
            </Show>
            {props.children}
          </div>
        </div>
      </Portal>
    </Show>
  );
};

export default Modal;
```

- [ ] **Step 2: Write `src/components/overlay/Modal/Modal.css`**

```css
.modal-scrim {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 15vh;
  z-index: 100;
  animation: scrim-in var(--duration-surface) var(--ease-standard);
}

.modal-panel {
  width: 560px;
  max-width: 90vw;
  max-height: 70vh;
  background: var(--c-bg-primary);
  border: 1px solid var(--c-border-subtle);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  animation: panel-in var(--duration-surface) var(--ease-standard);
}

.modal-title {
  padding: var(--space-4);
  font-size: var(--text-lg);
  font-weight: var(--weight-heading);
  border-bottom: 1px solid var(--c-border-subtle);
}

@keyframes scrim-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes panel-in {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
```

- [ ] **Step 3: Add to Gallery**

Add import:

```tsx
import Modal from '../../components/overlay/Modal/Modal';
```

Add a signal:

```tsx
  const [modalOpen, setModalOpen] = createSignal(false);
```

Insert section:

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Overlay — Modal</div>
        <Button variant="secondary" onClick={() => setModalOpen(true)}>Open modal</Button>
        <Modal open={modalOpen()} onClose={() => setModalOpen(false)} title="Rename note">
          <div style={{ padding: 'var(--space-4)' }}>Modal body content.</div>
        </Modal>
      </section>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, click "Open modal", confirm the scrim and panel fade/slide in, and confirm both clicking the scrim and pressing Escape close it.

- [ ] **Step 5: Commit**

```bash
git add src/components/overlay/Modal src/screens/Gallery/Gallery.tsx
git commit -m "Add Modal component"
```

---

### Task 20: Overlay — CommandPalette

**Files:**
- Create: `src/components/overlay/CommandPalette/CommandPalette.tsx`
- Create: `src/components/overlay/CommandPalette/CommandPalette.css`
- Modify: `src/screens/Gallery/Gallery.tsx`

**Interfaces:**
- Consumes: `Modal` (Task 19), `TextInput` (Task 8).
- Produces: `CommandPalette`, `Command` (signature above), reused by `src/screens/Workspace/Workspace.tsx` (Task 22).

- [ ] **Step 1: Write `src/components/overlay/CommandPalette/CommandPalette.tsx`**

```tsx
import { createMemo, createSignal, For, Show } from 'solid-js';
import Modal from '../Modal/Modal';
import TextInput from '../../forms/TextInput/TextInput';
import './CommandPalette.css';

export interface Command {
  id: string;
  label: string;
  onRun: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}

const CommandPalette = (props: CommandPaletteProps) => {
  const [query, setQuery] = createSignal('');

  const filtered = createMemo(() =>
    props.commands.filter((c) => c.label.toLowerCase().includes(query().toLowerCase()))
  );

  const run = (command: Command) => {
    command.onRun();
    setQuery('');
    props.onClose();
  };

  return (
    <Modal open={props.open} onClose={props.onClose}>
      <div class="command-palette stack">
        <TextInput value={query()} onInput={setQuery} placeholder="Type a command…" />
        <div class="command-list stack divided-list scroll-y">
          <Show when={filtered().length > 0} fallback={<div class="command-empty">No matching commands.</div>}>
            <For each={filtered()}>
              {(command) => (
                <button type="button" class="command-item" onClick={() => run(command)}>
                  {command.label}
                </button>
              )}
            </For>
          </Show>
        </div>
      </div>
    </Modal>
  );
};

export default CommandPalette;
```

- [ ] **Step 2: Write `src/components/overlay/CommandPalette/CommandPalette.css`**

```css
.command-palette {
  padding: var(--space-4);
  gap: var(--space-3);
}

.command-list {
  max-height: 40vh;
}

.command-item {
  width: 100%;
  text-align: left;
  padding: var(--space-3) var(--space-2);
  font-size: var(--text-sm);
  color: var(--c-fg-primary);
  transition: background var(--duration-state) var(--ease-standard);
}

.command-item:hover {
  background: var(--c-bg-tertiary);
}

.command-empty {
  padding: var(--space-3) var(--space-2);
  color: var(--c-fg-muted);
  font-size: var(--text-sm);
}
```

- [ ] **Step 3: Add to Gallery**

Add import:

```tsx
import CommandPalette from '../../components/overlay/CommandPalette/CommandPalette';
```

Add a signal:

```tsx
  const [paletteOpen, setPaletteOpen] = createSignal(false);
```

Insert section:

```tsx
      <section class="gallery-section stack">
        <div class="eyebrow">Overlay — CommandPalette</div>
        <Button variant="secondary" onClick={() => setPaletteOpen(true)}>Open command palette</Button>
        <CommandPalette
          open={paletteOpen()}
          onClose={() => setPaletteOpen(false)}
          commands={[
            { id: 'a', label: 'Open Vault…', onRun: () => {} },
            { id: 'b', label: 'Toggle theme', onRun: () => {} },
          ]}
        />
      </section>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, open the palette, type a partial match, confirm the list filters live, and confirm typing a non-matching string shows "No matching commands."

- [ ] **Step 5: Commit**

```bash
git add src/components/overlay/CommandPalette src/screens/Gallery/Gallery.tsx
git commit -m "Add CommandPalette component"
```

---

### Task 21: Fixtures — mock vault data

**Files:**
- Create: `src/fixtures/vault.ts`
- Create: `src/fixtures/notes.ts`
- Create: `src/fixtures/backlinks.ts`

**Interfaces:**
- Consumes: `FileKind` from `src/components/data/FileTreeRow/FileIcon.tsx` (Task 16).
- Produces: `VaultNode`, `vaultTree`; `Note`, `activeNote`; `Backlink`, `backlinks`, `unlinkedMentions` — consumed by the Workspace screen (Task 22).

- [ ] **Step 1: Write `src/fixtures/vault.ts`**

```ts
import type { FileKind } from '../components/data/FileTreeRow/FileIcon';

export interface VaultNode {
  id: string;
  name: string;
  kind: FileKind;
  children?: VaultNode[];
}

export const vaultTree: VaultNode[] = [
  {
    id: 'projects',
    name: 'Projects',
    kind: 'folder',
    children: [
      { id: 'cubical-roadmap', name: 'Cubical roadmap.md', kind: 'md' },
      { id: 'design-notes', name: 'Design notes.md', kind: 'md' },
      { id: 'old-spec', name: 'Old spec.md', kind: 'broken' },
    ],
  },
  {
    id: 'daily',
    name: 'Daily',
    kind: 'folder',
    children: [
      { id: '2026-07-12', name: '2026-07-12.md', kind: 'md' },
      { id: '2026-07-13', name: '2026-07-13.md', kind: 'md' },
    ],
  },
  { id: 'moodboard', name: 'moodboard.png', kind: 'png' },
  { id: 'cube-mark', name: 'cube-mark.svg', kind: 'svg' },
  { id: 'readme', name: 'README.txt', kind: 'txt' },
];
```

- [ ] **Step 2: Write `src/fixtures/notes.ts`**

```ts
export interface Note {
  id: string;
  title: string;
  frontmatter: Record<string, string>;
  body: string;
  tags: string[];
}

export const activeNote: Note = {
  id: 'design-notes',
  title: 'Design notes',
  frontmatter: {
    created: '2026-07-10',
    status: 'active',
  },
  tags: ['design', 'cubical'],
  body: `# Design notes

The accent color means state, never decoration. See [[Cubical roadmap]] for
sequencing.

## Open questions

- Should the minimap show heading density or line density?
- Confirm high-contrast theme pairs with [[Old spec]] (broken link).
`,
};
```

- [ ] **Step 3: Write `src/fixtures/backlinks.ts`**

```ts
export interface Backlink {
  id: string;
  noteTitle: string;
  snippet: string;
}

export const backlinks: Backlink[] = [
  { id: 'roadmap-1', noteTitle: 'Cubical roadmap', snippet: 'Design notes cover the accent-as-state rule in depth.' },
  { id: 'daily-1', noteTitle: '2026-07-12', snippet: 'Reviewed design notes before standup.' },
];

export const unlinkedMentions: Backlink[] = [
  { id: 'moodboard-1', noteTitle: 'moodboard', snippet: 'File referenced by name only, no [[wiki-link]] yet.' },
];
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect no errors.

- [ ] **Step 5: Commit**

```bash
git add src/fixtures
git commit -m "Add mock vault, note, and backlink fixtures"
```

---

### Task 22: Screen — Workspace

**Files:**
- Create: `src/screens/Workspace/Topbar.tsx`
- Create: `src/screens/Workspace/Topbar.css`
- Create: `src/screens/Workspace/FileTree.tsx`
- Create: `src/screens/Workspace/FileTree.css`
- Create: `src/screens/Workspace/Editor.tsx`
- Create: `src/screens/Workspace/Editor.css`
- Create: `src/screens/Workspace/Minimap.tsx`
- Create: `src/screens/Workspace/Minimap.css`
- Create: `src/screens/Workspace/RightSidebar.tsx`
- Create: `src/screens/Workspace/RightSidebar.css`
- Create: `src/screens/Workspace/StatusBar.tsx`
- Create: `src/screens/Workspace/StatusBar.css`
- Create: `src/screens/Workspace/Workspace.css`
- Modify: `src/screens/Workspace/Workspace.tsx`

**Interfaces:**
- Consumes: `CubeMark` (Task 5), `IconButton` (Task 7), `FileTreeRow`/`FileKind` (Task 16), `SegmentedControl` (Task 10), `BacklinkRow` (Task 17), `CommandPalette`/`Command` (Task 20), `vaultTree`/`VaultNode` (Task 21), `activeNote` (Task 21), `backlinks`/`unlinkedMentions` (Task 21), `screen`/`setScreen` (Task 4).
- Produces: the assembled Workspace screen.

- [ ] **Step 1: Write `src/screens/Workspace/Topbar.tsx`**

```tsx
import CubeMark from '../../components/brand/CubeMark/CubeMark';
import IconButton from '../../components/forms/IconButton/IconButton';
import './Topbar.css';

export interface TopbarProps {
  vaultName: string;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
}

const Topbar = (props: TopbarProps) => {
  return (
    <header class="topbar row">
      <div class="topbar-brand row">
        <CubeMark size={18} />
        <span class="topbar-vault-name">{props.vaultName}</span>
      </div>
      <div class="topbar-actions row">
        <IconButton label="Open command palette" onClick={() => props.onOpenCommandPalette()}>{'</>'}</IconButton>
        <IconButton label="Settings" onClick={() => props.onOpenSettings()}>⚙</IconButton>
      </div>
    </header>
  );
};

export default Topbar;
```

- [ ] **Step 2: Write `src/screens/Workspace/Topbar.css`**

```css
.topbar {
  height: 40px;
  padding: 0 var(--space-4);
  justify-content: space-between;
  background: var(--c-bg-secondary);
  border-bottom: 1px solid var(--c-border-subtle);
}

.topbar-brand {
  gap: var(--space-2);
  color: var(--c-fg-primary);
}

.topbar-vault-name {
  font-size: var(--text-sm);
  font-weight: var(--weight-heading);
}

.topbar-actions {
  gap: var(--space-1);
}
```

- [ ] **Step 3: Write `src/screens/Workspace/FileTree.tsx`**

```tsx
import { For, createSignal, Show } from 'solid-js';
import FileTreeRow from '../../components/data/FileTreeRow/FileTreeRow';
import { VaultNode } from '../../fixtures/vault';
import './FileTree.css';

export interface FileTreeProps {
  nodes: VaultNode[];
  selectedId: string;
  onSelect: (node: VaultNode) => void;
}

const FileTreeBranch = (props: {
  node: VaultNode;
  depth: number;
  selectedId: string;
  onSelect: (node: VaultNode) => void;
}) => {
  const [expanded, setExpanded] = createSignal(true);
  const isFolder = () => props.node.kind === 'folder';

  return (
    <div>
      <FileTreeRow
        name={props.node.name}
        depth={props.depth}
        kind={isFolder() ? (expanded() ? 'folder-open' : 'folder') : props.node.kind}
        selected={props.selectedId === props.node.id}
        invalid={props.node.kind === 'broken'}
        onClick={() => (isFolder() ? setExpanded((v) => !v) : props.onSelect(props.node))}
      />
      <Show when={isFolder() && expanded()}>
        <For each={props.node.children}>
          {(child) => (
            <FileTreeBranch node={child} depth={props.depth + 1} selectedId={props.selectedId} onSelect={props.onSelect} />
          )}
        </For>
      </Show>
    </div>
  );
};

const FileTree = (props: FileTreeProps) => {
  return (
    <div class="file-tree scroll-y">
      <For each={props.nodes}>
        {(node) => <FileTreeBranch node={node} depth={0} selectedId={props.selectedId} onSelect={props.onSelect} />}
      </For>
    </div>
  );
};

export default FileTree;
```

- [ ] **Step 4: Write `src/screens/Workspace/FileTree.css`**

```css
.file-tree {
  width: 240px;
  flex-shrink: 0;
  background: var(--c-bg-secondary);
  border-right: 1px solid var(--c-border-subtle);
}
```

- [ ] **Step 5: Write `src/screens/Workspace/Editor.tsx`**

```tsx
import { onCleanup, onMount } from 'solid-js';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import './Editor.css';

export interface EditorProps {
  initialContent: string;
  onReady?: (view: EditorView) => void;
}

const cubicalTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--text-base)',
    color: 'var(--c-fg-primary)',
    backgroundColor: 'var(--c-bg-primary)',
  },
  '.cm-content': {
    fontFamily: 'var(--font-sans)',
    padding: 'var(--space-6)',
    caretColor: 'var(--c-accent)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--c-bg-primary)',
    color: 'var(--c-fg-muted)',
    border: 'none',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-xs)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--c-bg-secondary)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--c-bg-secondary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'var(--c-bg-tertiary)',
  },
  '.cm-cursor': { borderLeftColor: 'var(--c-accent)' },
});

const Editor = (props: EditorProps) => {
  let host: HTMLDivElement | undefined;
  let view: EditorView | undefined;

  onMount(() => {
    view = new EditorView({
      state: EditorState.create({
        doc: props.initialContent,
        extensions: [lineNumbers(), history(), keymap.of([...defaultKeymap, ...historyKeymap]), markdown(), cubicalTheme],
      }),
      parent: host,
    });
    props.onReady?.(view);
  });

  onCleanup(() => view?.destroy());

  return <div class="editor scroll-y" ref={host} />;
};

export default Editor;
```

- [ ] **Step 6: Write `src/screens/Workspace/Editor.css`**

```css
.editor {
  flex: 1;
  min-width: 0;
}

.editor .cm-editor {
  height: 100%;
}
```

- [ ] **Step 7: Write `src/screens/Workspace/Minimap.tsx`**

```tsx
import { For, createMemo } from 'solid-js';
import './Minimap.css';

export interface MinimapProps {
  content: string;
  onJump: (lineIndex: number) => void;
}

const Minimap = (props: MinimapProps) => {
  const lines = createMemo(() => props.content.split('\n'));

  return (
    <div class="minimap stack">
      <For each={lines()}>
        {(line, i) => (
          <div
            class="minimap-line"
            style={{ width: `${Math.min(100, line.length * 2)}%` }}
            onClick={() => props.onJump(i())}
          />
        )}
      </For>
    </div>
  );
};

export default Minimap;
```

- [ ] **Step 8: Write `src/screens/Workspace/Minimap.css`**

```css
.minimap {
  width: 48px;
  flex-shrink: 0;
  padding: var(--space-2);
  gap: 2px;
  background: var(--c-bg-secondary);
  border-left: 1px solid var(--c-border-subtle);
  overflow: hidden;
}

.minimap-line {
  height: 2px;
  background: var(--c-border-strong);
  cursor: pointer;
}

.minimap-line:hover {
  background: var(--c-accent);
}
```

- [ ] **Step 9: Write `src/screens/Workspace/RightSidebar.tsx`**

```tsx
import { createSignal, For } from 'solid-js';
import SegmentedControl from '../../components/forms/SegmentedControl/SegmentedControl';
import BacklinkRow from '../../components/data/BacklinkRow/BacklinkRow';
import { backlinks, unlinkedMentions } from '../../fixtures/backlinks';
import './RightSidebar.css';

const RightSidebar = () => {
  const [tab, setTab] = createSignal('backlinks');

  return (
    <aside class="right-sidebar stack">
      <SegmentedControl
        value={tab()}
        onChange={setTab}
        options={[
          { label: 'Backlinks', value: 'backlinks' },
          { label: 'Mentions', value: 'mentions' },
        ]}
      />
      <div class="right-sidebar-list stack divided-list scroll-y">
        <For each={tab() === 'backlinks' ? backlinks : unlinkedMentions}>
          {(item) => <BacklinkRow noteTitle={item.noteTitle} snippet={item.snippet} />}
        </For>
      </div>
    </aside>
  );
};

export default RightSidebar;
```

- [ ] **Step 10: Write `src/screens/Workspace/RightSidebar.css`**

```css
.right-sidebar {
  width: 260px;
  flex-shrink: 0;
  padding: var(--space-4);
  gap: var(--space-2);
  background: var(--c-bg-secondary);
  border-left: 1px solid var(--c-border-subtle);
}

.right-sidebar-list {
  margin: 0 calc(var(--space-4) * -1);
}
```

- [ ] **Step 11: Write `src/screens/Workspace/StatusBar.tsx`**

```tsx
import './StatusBar.css';

export interface StatusBarProps {
  wordCount: number;
  noteTitle: string;
}

const StatusBar = (props: StatusBarProps) => {
  return (
    <footer class="status-bar row eyebrow">
      <span>{props.noteTitle}</span>
      <span>{props.wordCount} words</span>
    </footer>
  );
};

export default StatusBar;
```

- [ ] **Step 12: Write `src/screens/Workspace/StatusBar.css`**

```css
.status-bar {
  height: 24px;
  padding: 0 var(--space-4);
  justify-content: space-between;
  background: var(--c-bg-secondary);
  border-top: 1px solid var(--c-border-subtle);
  color: var(--c-fg-muted);
}
```

- [ ] **Step 13: Write `src/screens/Workspace/Workspace.css`**

```css
.workspace {
  height: 100%;
  min-height: 0;
}

.workspace-body {
  flex: 1;
  min-height: 0;
  align-items: stretch;
}
```

- [ ] **Step 14: Replace `src/screens/Workspace/Workspace.tsx`**

```tsx
import { createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { EditorView } from '@codemirror/view';
import Topbar from './Topbar';
import FileTree from './FileTree';
import Editor from './Editor';
import Minimap from './Minimap';
import RightSidebar from './RightSidebar';
import StatusBar from './StatusBar';
import CommandPalette, { Command } from '../../components/overlay/CommandPalette/CommandPalette';
import { vaultTree, VaultNode } from '../../fixtures/vault';
import { activeNote } from '../../fixtures/notes';
import { setScreen } from '../../App';
import './Workspace.css';

const Workspace = () => {
  const [selectedId, setSelectedId] = createSignal(activeNote.id);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  const [editorView, setEditorView] = createSignal<EditorView>();

  const wordCount = createMemo(() => activeNote.body.trim().split(/\s+/).filter(Boolean).length);

  const jumpToLine = (lineIndex: number) => {
    const view = editorView();
    if (!view) return;
    const line = view.state.doc.line(Math.min(lineIndex + 1, view.state.doc.lines));
    view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    view.focus();
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      setPaletteOpen(true);
    }
  };

  onMount(() => document.addEventListener('keydown', handleKeydown));
  onCleanup(() => document.removeEventListener('keydown', handleKeydown));

  const selectNode = (node: VaultNode) => setSelectedId(node.id);

  const commands: Command[] = [
    { id: 'open-settings', label: 'Open settings', onRun: () => setScreen('settings') },
    { id: 'open-daily', label: "Open today's daily note", onRun: () => setSelectedId('2026-07-13') },
  ];

  return (
    <div class="workspace stack">
      <Topbar
        vaultName="Cubical vault"
        onOpenCommandPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => setScreen('settings')}
      />
      <div class="workspace-body row">
        <FileTree nodes={vaultTree} selectedId={selectedId()} onSelect={selectNode} />
        <Editor initialContent={activeNote.body} onReady={setEditorView} />
        <Minimap content={activeNote.body} onJump={jumpToLine} />
        <RightSidebar />
      </div>
      <StatusBar wordCount={wordCount()} noteTitle={activeNote.title} />
      <CommandPalette open={paletteOpen()} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
  );
};

export default Workspace;
```

- [ ] **Step 15: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, switch to the Workspace tab and confirm: the file tree renders the fixture folders/files, "Design notes.md" is preselected and shows the accent rail, the editor is a real, typeable CodeMirror instance showing the fixture Markdown, clicking a minimap bar moves the editor caret and scrolls to that line, the right sidebar's Backlinks/Mentions tabs switch content, and both the topbar `</>` button and Cmd/Ctrl+K open the command palette.

- [ ] **Step 16: Commit**

```bash
git add src/screens/Workspace
git commit -m "Build Workspace screen with file tree, CodeMirror editor, minimap, and sidebar"
```

---

### Task 23: Screen — EmptyVault

**Files:**
- Create: `src/screens/EmptyVault/EmptyVault.css`
- Modify: `src/screens/EmptyVault/EmptyVault.tsx`

**Interfaces:**
- Consumes: `CubeMark` (Task 5), `Button` (Task 6), `setScreen` (Task 4).

- [ ] **Step 1: Write `src/screens/EmptyVault/EmptyVault.css`**

```css
.empty-vault {
  height: 100%;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  text-align: center;
  color: var(--c-fg-secondary);
}

.empty-vault-copy {
  font-size: var(--text-sm);
  max-width: 320px;
  margin: 0;
}
```

- [ ] **Step 2: Replace `src/screens/EmptyVault/EmptyVault.tsx`**

```tsx
import CubeMark from '../../components/brand/CubeMark/CubeMark';
import Button from '../../components/forms/Button/Button';
import { setScreen } from '../../App';
import './EmptyVault.css';

const EmptyVault = () => {
  return (
    <div class="empty-vault stack">
      <CubeMark size={40} />
      <h1>No vault open</h1>
      <p class="empty-vault-copy">Open a folder of Markdown files to get started.</p>
      <Button variant="primary" onClick={() => setScreen('workspace')}>Open Vault…</Button>
    </div>
  );
};

export default EmptyVault;
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, switch to the Empty vault tab, confirm the centered cube mark, heading, copy, and primary "Open Vault…" button render, and confirm clicking the button switches to the Workspace tab.

- [ ] **Step 4: Commit**

```bash
git add src/screens/EmptyVault
git commit -m "Build Empty vault screen"
```

---

### Task 24: Screen — Settings

**Files:**
- Create: `src/screens/Settings/Settings.css`
- Modify: `src/screens/Settings/Settings.tsx`

**Interfaces:**
- Consumes: `SegmentedControl` (Task 10), `theme`/`applyTheme`/`ThemeName` (Task 4).

- [ ] **Step 1: Write `src/screens/Settings/Settings.css`**

```css
.settings {
  padding: var(--space-6);
  gap: var(--space-6);
  max-width: 480px;
}

.settings-section {
  gap: var(--space-3);
}
```

- [ ] **Step 2: Replace `src/screens/Settings/Settings.tsx`**

```tsx
import SegmentedControl from '../../components/forms/SegmentedControl/SegmentedControl';
import { theme, applyTheme, ThemeName } from '../../theme';
import './Settings.css';

const Settings = () => {
  return (
    <div class="settings stack">
      <h1>Settings</h1>
      <section class="settings-section stack">
        <div class="eyebrow">Appearance</div>
        <SegmentedControl
          value={theme()}
          onChange={(v) => applyTheme(v as ThemeName)}
          options={[
            { label: 'Light', value: 'light' },
            { label: 'Dark', value: 'dark' },
            { label: 'High contrast', value: 'high-contrast' },
          ]}
        />
      </section>
    </div>
  );
};

export default Settings;
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck` — expect no errors.
In the browser, switch to the Settings tab, click each of Light/Dark/High contrast, and confirm the whole app repaints with that theme's tokens (including the Gallery and Workspace screens when you switch back to them).

- [ ] **Step 4: Commit**

```bash
git add src/screens/Settings
git commit -m "Build Settings screen with theme switcher"
```

---

### Task 25: README

**Files:**
- Create: `README.md`

**Interfaces:**
- None (documentation only).

- [ ] **Step 1: Write `README.md`**

```markdown
# Cubical Design System

A SolidJS design system for **Cubical**, a local-first Markdown knowledge base.
Design language: "Machinist / Graphite" — chrome recedes, the user's text is
the loudest thing on screen.

## The one rule

`--c-accent` means exactly one thing: **state** — selection, active, focus,
caret, resolved wiki-links and tags. It is never used as brand decoration.
Identity is carried by the warm-neutral surface and the cube mark. Saturated
color (`--c-success` / `--c-warning` / `--c-error`) is rationed to status only.

## Getting started

    npm install
    npm run dev

Open the printed local URL. The dev switcher at the top of the page moves
between the Gallery, Workspace, Empty vault, and Settings screens.

## Tokens

All values live in `src/styles/tokens.css`: an un-themed base layer (spacing,
radii, type ramp, motion, elevation) and three theme scopes
(`[data-theme="light|dark|high-contrast"]`) that override the semantic color
aliases (`--c-bg-*`, `--c-fg-*`, `--c-border-*`, `--c-accent`, status colors).
Components reference semantic aliases only — never raw hex.

## Components

- `forms/` — Button, IconButton, TextInput, Toggle, SegmentedControl
- `feedback/` — Badge, Callout, Toast, Tooltip
- `overlay/` — Menu, Modal, CommandPalette
- `data/` — Tag, FileTreeRow, BacklinkRow
- `brand/` — CubeMark

Every component's states are demonstrated on the Gallery screen
(`src/screens/Gallery`), including the theme switcher so all three themes can
be checked in place.

## Screens

- **Workspace** — topbar, file tree, a real CodeMirror 6 Markdown editor,
  right sidebar (Backlinks / Mentions), status bar, minimap.
- **Empty vault** — first-run state.
- **Settings** — theme switcher.
- **Gallery** — full component state matrix.

## Conventions

- Solid idioms only (`createSignal`, `createMemo`, `<Show>`, `<For>`, props
  accessed as `props.x`).
- No hardcoded hex or px values in component CSS — everything is a token.
- Motion is `transform`/`opacity` only: 120ms for state, 200ms for surfaces.
  `prefers-reduced-motion` collapses both to 0ms.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Add README documenting tokens, components, screens, and the one rule"
```

---

### Task 26: Final verification pass

**Files:**
- None created; this task only verifies.

**Interfaces:**
- None.

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck` — expect no errors.

- [ ] **Step 2: Dependency audit**

Run: `cat package.json | grep -iE "react|tailwind|styled-components|emotion"` — expect no output (empty match confirms no forbidden dependencies).

- [ ] **Step 3: Production build**

Run: `npm run build` — expect it to complete without errors and produce a `dist/` directory.

- [ ] **Step 4: Full manual click-through**

Run: `npm run dev &`, open the browser at the printed URL, and work through this checklist:
- Gallery: every section from Tasks 5–20 is present; toggling Light/Dark/High-contrast in Settings and returning to Gallery shows all components repainted correctly in each theme.
- Workspace: select several file-tree rows (folder expand/collapse, selected row's accent rail, the invalid "Old spec.md" row's warning styling), type in the CodeMirror editor, click a minimap bar and confirm the caret jumps, switch the Backlinks/Mentions tabs, open the command palette via both the topbar button and Cmd/Ctrl+K, filter and run a command.
- Empty vault: renders correctly, "Open Vault…" switches to Workspace.
- Settings: theme switching persists across a page reload (re-open the browser tab and confirm the previously selected theme is still applied, backed by the `localStorage` write in `src/theme.ts`).
- Keyboard: Tab through interactive elements on each screen and confirm the focus ring (`2px solid var(--c-focus-ring)`, 2px offset) is always visible.

Stop the dev server when done.

- [ ] **Step 5: Commit** (only if Step 4 surfaced fixes)

If the click-through in Step 4 required any code changes, commit them individually with messages describing the specific fix. If no changes were needed, skip this step — there is nothing to commit.
