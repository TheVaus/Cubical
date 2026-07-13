import { createSignal } from 'solid-js';
import './Gallery.css';
import CubeMark from '../../components/brand/CubeMark/CubeMark';
import Button from '../../components/forms/Button/Button';
import IconButton from '../../components/forms/IconButton/IconButton';
import TextInput from '../../components/forms/TextInput/TextInput';
import Toggle from '../../components/forms/Toggle/Toggle';
import SegmentedControl from '../../components/forms/SegmentedControl/SegmentedControl';
import Badge from '../../components/feedback/Badge/Badge';

const Gallery = () => {
  const [textInputValue, setTextInputValue] = createSignal('');
  const [toggleValue, setToggleValue] = createSignal(true);
  const [segmentValue, setSegmentValue] = createSignal('backlinks');

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
    </div>
  );
};

export default Gallery;
