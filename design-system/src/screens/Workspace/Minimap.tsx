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
