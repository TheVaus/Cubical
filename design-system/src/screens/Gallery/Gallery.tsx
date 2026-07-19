import { createSignal, For, Show } from 'solid-js';
import './Gallery.css';
import CubeMark from '../../components/brand/CubeMark/CubeMark';
import Icon, { type IconName } from '../../components/graphics/Icon/Icon';
import Button from '../../components/forms/Button/Button';
import IconButton from '../../components/forms/IconButton/IconButton';
import TextInput from '../../components/forms/TextInput/TextInput';
import Toggle from '../../components/forms/Toggle/Toggle';
import SegmentedControl from '../../components/forms/SegmentedControl/SegmentedControl';
import Badge from '../../components/feedback/Badge/Badge';
import Callout from '../../components/feedback/Callout/Callout';
import Toast from '../../components/feedback/Toast/Toast';
import Tooltip from '../../components/feedback/Tooltip/Tooltip';
import Tag from '../../components/data/Tag/Tag';
import FileTreeRow from '../../components/data/FileTreeRow/FileTreeRow';
import BacklinkRow from '../../components/data/BacklinkRow/BacklinkRow';
import Menu from '../../components/overlay/Menu/Menu';
import Modal from '../../components/overlay/Modal/Modal';
import CommandPalette from '../../components/overlay/CommandPalette/CommandPalette';

const ALL_ICONS: IconName[] = [
  'plus', 'folder-plus', 'info', 'chevron-right', 'chevron-down',
  'close', 'edit', 'settings', 'warning', 'sun', 'moon', 'link',
  'file-text', 'bar-chart', 'palette', 'puzzle', 'library', 'keyboard',
  'hash', 'command',
];

const Gallery = () => {
  const [textInputValue, setTextInputValue] = createSignal('');
  const [toggleValue, setToggleValue] = createSignal(true);
  const [segmentValue, setSegmentValue] = createSignal('backlinks');
  const [showToast, setShowToast] = createSignal(false);
  const [modalOpen, setModalOpen] = createSignal(false);
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);

  return (
    <div class="gallery stack scroll-y">
      <h1>Component gallery</h1>
      <section class="gallery-section stack">
        <div class="eyebrow">Brand — CubeMark</div>
        <div class="gallery-row row">
          <CubeMark size={16} />
          <CubeMark size={24} />
          <CubeMark size={40} />
        </div>
      </section>
      <section class="gallery-section stack">
        <div class="eyebrow">Forms — Button</div>
        <div class="gallery-row row">
          <Button variant="secondary">Secondary</Button>
          <Button variant="primary">Primary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="secondary" disabled>Disabled</Button>
        </div>
        <div class="gallery-row row">
          <Button variant="secondary" size="sm">Small secondary</Button>
          <Button variant="primary" size="sm">Small primary</Button>
        </div>
        <div class="stack" style={{ width: '240px' }}>
          <Button variant="ghost" block>
            <span style={{ 'font-weight': '500' }}>Block ghost row</span>
            <span style={{ color: 'var(--c-fg-muted)', 'font-size': 'var(--text-xs)' }}>
              Left-aligned, multi-line content
            </span>
          </Button>
        </div>
      </section>
      <section class="gallery-section stack">
        <div class="eyebrow">Forms — IconButton</div>
        <div class="gallery-row row">
          <IconButton label="Resting">⚙</IconButton>
          <IconButton label="Active" active>⚙</IconButton>
          <IconButton label="Disabled" disabled>⚙</IconButton>
        </div>
      </section>
      <section class="gallery-section stack">
        <div class="eyebrow">Forms — TextInput</div>
        <div class="gallery-row row">
          <TextInput value={textInputValue()} onInput={setTextInputValue} placeholder="Search notes…" />
          <TextInput value="" onInput={() => {}} placeholder="Disabled" disabled />
        </div>
      </section>
      <section class="gallery-section stack">
        <div class="eyebrow">Forms — Toggle</div>
        <div class="gallery-row row">
          <Toggle checked={toggleValue()} onChange={setToggleValue} label="Enable feature" />
          <Toggle checked={false} onChange={() => {}} disabled label="Disabled" />
          <Toggle checked={toggleValue()} onChange={setToggleValue} showLabel label={toggleValue() ? 'On' : 'Off'} />
        </div>
      </section>
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
      <section class="gallery-section stack">
        <div class="eyebrow">Feedback — Badge</div>
        <div class="gallery-row row">
          <Badge>Neutral</Badge>
          <Badge tone="success">Success</Badge>
          <Badge tone="warning">Warning</Badge>
          <Badge tone="error">Error</Badge>
        </div>
      </section>
      <section class="gallery-section stack">
        <div class="eyebrow">Feedback — Callout</div>
        <div class="stack" style={{ gap: 'var(--space-3)' }}>
          <Callout title="Note">Neutral callout copy.</Callout>
          <Callout tone="success" title="Indexed">Vault indexed — 1,204 notes.</Callout>
          <Callout tone="warning" title="Unresolved link">This note has 2 broken wiki-links.</Callout>
          <Callout tone="error" title="Write failed">Could not save — disk full.</Callout>
        </div>
      </section>
      <section class="gallery-section stack">
        <div class="eyebrow">Feedback — Toast</div>
        <div class="gallery-row row">
          <Button variant="secondary" onClick={() => setShowToast(true)}>Trigger toast</Button>
        </div>
        <Show when={showToast()}>
          <Toast message="Vault indexed — 1,204 notes." tone="success" onDismiss={() => setShowToast(false)} />
        </Show>
      </section>
      <section class="gallery-section stack">
        <div class="eyebrow">Feedback — Tooltip</div>
        <div class="gallery-row row">
          <Tooltip label="Reveal in file tree">
            <IconButton label="Reveal">⌄</IconButton>
          </Tooltip>
        </div>
      </section>
      <section class="gallery-section stack">
        <div class="eyebrow">Data — Tag</div>
        <div class="gallery-row row">
          <Tag label="design" />
          <Tag label="cubical" resolved />
        </div>
      </section>
      <section class="gallery-section stack">
        <div class="eyebrow">Data — FileTreeRow</div>
        <div class="stack" style={{ width: '240px', border: '1px solid var(--c-border-subtle)' }}>
          <FileTreeRow name="Projects" depth={0} kind="folder" />
          <FileTreeRow name="Design notes.md" depth={1} kind="md" selected />
          <FileTreeRow name="Old spec.md" depth={1} kind="broken" invalid />
          <FileTreeRow name="moodboard.png" depth={0} kind="png" renaming onRenameCommit={() => {}} />
        </div>
      </section>
      <section class="gallery-section stack">
        <div class="eyebrow">Data — BacklinkRow</div>
        <div class="stack divided-list" style={{ width: '320px', border: '1px solid var(--c-border-subtle)' }}>
          <BacklinkRow noteTitle="Cubical roadmap" snippet="Design notes cover the accent-as-state rule in depth." matchQuery="accent" />
          <BacklinkRow noteTitle="2026-07-12" snippet="Reviewed design notes before standup." />
        </div>
      </section>
      <section class="gallery-section stack">
        <div class="eyebrow">Overlay — Menu</div>
        <Menu
          items={[
            { id: 'rename', label: 'Rename…', shortcut: '⌘R', onSelect: () => {} },
            { id: 'reveal', label: 'Reveal in file tree', disabled: true, onSelect: () => {} },
            { id: 'delete', label: 'Delete…', danger: true, onSelect: () => {} },
          ]}
        />
      </section>
      <section class="gallery-section stack">
        <div class="eyebrow">Overlay — Modal</div>
        <div class="gallery-row row">
          <Button variant="secondary" onClick={() => setModalOpen(true)}>Open modal</Button>
          <Button variant="secondary" onClick={() => setConfirmOpen(true)}>Open confirm (sm/center)</Button>
        </div>
        <Modal open={modalOpen()} onClose={() => setModalOpen(false)} title="Rename note">
          <div style={{ padding: 'var(--space-4)' }}>Modal body content.</div>
        </Modal>
        <Modal
          open={confirmOpen()}
          onClose={() => setConfirmOpen(false)}
          size="sm"
          placement="center"
          ariaLabel="Confirm delete"
        >
          <div style={{ padding: 'var(--space-4)', display: 'flex', 'flex-direction': 'column', gap: 'var(--space-3)' }}>
            <p style={{ margin: 0, 'font-size': 'var(--text-sm)' }}>Delete "note.md"?</p>
            <div style={{ display: 'flex', 'justify-content': 'flex-end', gap: 'var(--space-2)' }}>
              <Button variant="secondary" onClick={() => setConfirmOpen(false)}>Cancel</Button>
              <Button variant="danger" onClick={() => setConfirmOpen(false)}>Delete</Button>
            </div>
          </div>
        </Modal>
      </section>
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
      <section class="gallery-section stack">
        <div class="eyebrow">Graphics — Icon</div>
        <div class="icon-gallery">
          <For each={ALL_ICONS}>
            {(n) => (
              <div class="icon-gallery__cell">
                <Icon name={n} size={20} />
                <code>{n}</code>
              </div>
            )}
          </For>
        </div>
      </section>
    </div>
  );
};

export default Gallery;
