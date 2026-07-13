import './TextInput.css';

export interface TextInputProps {
  value: string;
  onInput: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
}

const TextInput = (props: TextInputProps) => {
  return (
    <input
      class="text-input"
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onInput={(e) => props.onInput(e.currentTarget.value)}
    />
  );
};

export default TextInput;
