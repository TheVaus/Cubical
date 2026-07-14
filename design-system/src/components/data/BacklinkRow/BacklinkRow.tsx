import { Show } from 'solid-js';
import './BacklinkRow.css';

export interface BacklinkRowProps {
  noteTitle: string;
  snippet: string;
  matchQuery?: string;
  onClick?: () => void;
}

interface SnippetPart {
  text: string;
  match: boolean;
}

const highlight = (snippet: string, query?: string): SnippetPart[] => {
  if (!query) return [{ text: snippet, match: false }];
  const idx = snippet.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return [{ text: snippet, match: false }];
  return [
    { text: snippet.slice(0, idx), match: false },
    { text: snippet.slice(idx, idx + query.length), match: true },
    { text: snippet.slice(idx + query.length), match: false },
  ];
};

const BacklinkRow = (props: BacklinkRowProps) => {
  return (
    <button type="button" class="backlink-row" onClick={() => props.onClick?.()}>
      <span class="backlink-title">{props.noteTitle}</span>
      <span class="backlink-snippet">
        {highlight(props.snippet, props.matchQuery).map((part) => (
          <Show when={part.match} fallback={<>{part.text}</>}>
            <mark>{part.text}</mark>
          </Show>
        ))}
      </span>
    </button>
  );
};

export default BacklinkRow;
