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
