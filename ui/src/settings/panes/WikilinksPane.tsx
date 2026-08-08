import InfoButton, { type InfoControl } from "../InfoButton";
import OnOffControl from "../OnOffControl";
import type { SettingsState } from "../settingsState";

const WikilinksPane = (props: {
  settings: SettingsState;
  info: InfoControl;
}) => (
  <>
    <h2 class="set-h2">Wiki links</h2>
    <div class="set-row">
      <div>
        <div class="set-row__lab">Repair broken links on rename</div>
        <div class="set-row__desc">
          When you rename a file, also fix links that point at its old name but
          had already broken (e.g. from an earlier rename). Off limits a rename
          to links that still resolve to the file.
        </div>
      </div>
      <div class="set-row__control">
        <InfoButton id="wiki-repair" info={props.info}>
          <p>
            <strong>On:</strong> renaming a file also fixes links that point at
            its old name but had already broken from an earlier rename.
          </p>
          <p>
            <strong>Off:</strong> a rename only updates links that still resolve
            to the file.
          </p>
        </InfoButton>
        <OnOffControl
          value={props.settings.rewriteBrokenLinks()}
          onChange={props.settings.setRewriteBrokenLinksValue}
        />
      </div>
    </div>
  </>
);

export default WikilinksPane;
