import CubeMark from '../../components/brand/CubeMark/CubeMark';
import IconButton from '../../components/forms/IconButton/IconButton';
import './Topbar.css';

export interface TopbarProps {
  vaultName: string;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
}

const Topbar = (props: TopbarProps) => {
  return (
    <header class="topbar row">
      <div class="topbar-brand row">
        <CubeMark size={18} />
        <span class="topbar-vault-name">{props.vaultName}</span>
      </div>
      <div class="topbar-actions row">
        <IconButton label="Open command palette" onClick={() => props.onOpenCommandPalette()}>{'</>'}</IconButton>
        <IconButton label="Settings" onClick={() => props.onOpenSettings()}>⚙</IconButton>
      </div>
    </header>
  );
};

export default Topbar;
