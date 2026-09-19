import './FileTreeRow.css';

export interface RenameInputProps {
  value: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

const RenameInput = (props: RenameInputProps) => {
  let settled = false;
  const settle = (then: () => void) => {
    if (settled) return;
    settled = true;
    then();
  };

  return (
    <input
      ref={(el) => queueMicrotask(() => el.focus())}
      type="text"
      class="tree-row__input"
      value={props.value}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const name = e.currentTarget.value;
          settle(() => props.onCommit(name));
        } else if (e.key === 'Escape') {
          e.preventDefault();
          settle(() => props.onCancel());
        }
      }}
      onBlur={(e) => {
        const name = e.currentTarget.value;
        settle(() => props.onCommit(name));
      }}
    />
  );
};

export default RenameInput;
