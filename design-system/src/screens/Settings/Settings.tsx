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
