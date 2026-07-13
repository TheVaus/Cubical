import { JSX } from 'solid-js';
import './Badge.css';

export type Tone = 'neutral' | 'success' | 'warning' | 'error';

export interface BadgeProps {
  tone?: Tone;
  children: JSX.Element;
}

const Badge = (props: BadgeProps) => {
  return (
    <span class="badge" classList={{ [props.tone ?? 'neutral']: true }}>
      {props.children}
    </span>
  );
};

export default Badge;
