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
