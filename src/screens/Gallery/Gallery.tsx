import { createSignal, Show } from 'solid-js';
import './Gallery.css';
import CubeMark from '../../components/brand/CubeMark/CubeMark';
import Button from '../../components/forms/Button/Button';
import IconButton from '../../components/forms/IconButton/IconButton';
import TextInput from '../../components/forms/TextInput/TextInput';
import Toggle from '../../components/forms/Toggle/Toggle';
import SegmentedControl from '../../components/forms/SegmentedControl/SegmentedControl';
import Badge from '../../components/feedback/Badge/Badge';
import Callout from '../../components/feedback/Callout/Callout';
import Toast from '../../components/feedback/Toast/Toast';
import Tooltip from '../../components/feedback/Tooltip/Tooltip';

const Gallery = () => {
  const [textInputValue, setTextInputValue] = createSignal('');
  const [toggleValue, setToggleValue] = createSignal(true);
  const [segmentValue, setSegmentValue] = createSignal('backlinks');
  const [showToast, setShowToast] = createSignal(false);

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
          <Button variant="secondary" disabled>Disabled</Button>
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
    </div>
  );
};

export default Gallery;
