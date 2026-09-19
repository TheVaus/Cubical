import { createEffect, onCleanup } from 'solid-js';

type Close = () => void;

const stack: Close[] = [];

const onKey = (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.stopPropagation();
  top();
};

export function closeOnEscape(open: () => boolean, close: Close): void {
  createEffect(() => {
    if (!open()) return;
    const entry: Close = () => close();
    if (stack.length === 0) document.addEventListener('keydown', onKey);
    stack.push(entry);
    onCleanup(() => {
      const at = stack.lastIndexOf(entry);
      if (at !== -1) stack.splice(at, 1);
      if (stack.length === 0) document.removeEventListener('keydown', onKey);
    });
  });
}
