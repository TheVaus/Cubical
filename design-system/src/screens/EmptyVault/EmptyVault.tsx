import CubeMark from '../../components/brand/CubeMark/CubeMark';
import Button from '../../components/forms/Button/Button';
import { setScreen } from '../../App';
import './EmptyVault.css';

const EmptyVault = () => {
  return (
    <div class="empty-vault stack">
      <CubeMark size={40} />
      <h1>No vault open</h1>
      <p class="empty-vault-copy">Open a folder of Markdown files to get started.</p>
      <Button variant="primary" onClick={() => setScreen('workspace')}>Open Vault…</Button>
    </div>
  );
};

export default EmptyVault;
