import { JSX, Show } from 'solid-js';
import './Callout.css';

export type Tone = 'neutral' | 'success' | 'warning' | 'error';

export interface CalloutProps {
  tone?: Tone;
  title?: string;
  children: JSX.Element;
}

const Callout = (props: CalloutProps) => {
  return (
    <div class="callout" classList={{ [props.tone ?? 'neutral']: true }}>
      <Show when={props.title}>
        <div class="callout-title">{props.title}</div>
      </Show>
      <div class="callout-body">{props.children}</div>
    </div>
  );
};

export default Callout;
