import './Gallery.css';
import CubeMark from '../../components/brand/CubeMark/CubeMark';

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
    </div>
  );
};

export default Gallery;
