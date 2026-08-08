import SegmentedControl from "@ds/components/forms/SegmentedControl/SegmentedControl";
import type { IconName } from "@ds/components/graphics/Icon/Icon";

import type { ThemeMode } from "../../styles/theme";
import type { SettingsState } from "../settingsState";

const THEME_ICON: Record<ThemeMode, IconName> = {
  system: "settings",
  light: "sun",
  dark: "moon",
};

const AppearancePane = (props: { settings: SettingsState }) => (
  <>
    <h2 class="set-h2">Appearance</h2>
    <div class="set-row">
      <div>
        <div class="set-row__lab">Theme</div>
        <div class="set-row__desc">
          Follow the system, or force light / dark.
        </div>
      </div>
      <SegmentedControl
        variant="pill"
        role="radiogroup"
        options={(["system", "light", "dark"] as ThemeMode[]).map((m) => ({
          label: m,
          value: m,
          icon: THEME_ICON[m],
        }))}
        value={props.settings.themeMode()}
        onChange={(v) => props.settings.setTheme(v as ThemeMode)}
      />
    </div>
  </>
);

export default AppearancePane;
