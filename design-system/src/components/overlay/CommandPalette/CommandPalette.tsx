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
      <div class="command-palette">
        <TextInput value={query()} onInput={setQuery} placeholder="Type a command…" />
        <div class="command-list">
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
