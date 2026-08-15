import Button from "@ds/components/forms/Button/Button";

const VaultPane = (props: {
  vaultPath: string | null;
  busy: boolean;
  onOpenAnother: () => void;
}) => (
  <>
    <h2 class="set-h2">Vault</h2>
    <div class="set-row">
      <div>
        <div class="set-row__lab">Current vault</div>
        <div class="set-row__desc">{props.vaultPath ?? "—"}</div>
      </div>
      <Button
        variant="primary"
        onClick={() => props.onOpenAnother()}
        disabled={props.busy}
      >
        Open another…
      </Button>
    </div>
  </>
);

export default VaultPane;
