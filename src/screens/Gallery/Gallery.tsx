import './Gallery.css';
import CubeMark from '../../components/brand/CubeMark/CubeMark';
import Button from '../../components/forms/Button/Button';
import IconButton from '../../components/forms/IconButton/IconButton';

const Gallery = () => {
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
    </div>
  );
};

export default Gallery;
