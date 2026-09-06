import './FileTreeRow.css';

export interface RenameInputProps {
  value: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

const RenameInput = (props: RenameInputProps) => (
  <input
    type="text"
    class="tree-row__input"
    value={props.value}
    autofocus
    onClick={(e) => e.stopPropagation()}
    onKeyDown={(e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        props.onCommit(e.currentTarget.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        props.onCancel();
      }
    }}
    onBlur={(e) => props.onCommit(e.currentTarget.value)}
  />
);

export default RenameInput;
