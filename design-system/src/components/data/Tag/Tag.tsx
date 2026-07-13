import './Tag.css';

export interface TagProps {
  label: string;
  resolved?: boolean;
  onClick?: () => void;
}

const Tag = (props: TagProps) => {
  return (
    <button type="button" class="tag" classList={{ resolved: props.resolved }} onClick={() => props.onClick?.()}>
      #{props.label}
    </button>
  );
};

export default Tag;
