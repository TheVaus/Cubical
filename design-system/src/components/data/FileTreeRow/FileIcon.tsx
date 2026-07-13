export type FileKind = 'folder' | 'folder-open' | 'md' | 'txt' | 'png' | 'svg' | 'pdf' | 'code' | 'canvas' | 'broken';

const DOC = 'M3.5 1.5h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z';
const DOC_FOLD = 'M9.5 1.5v3h3';

export interface FileIconProps {
  kind: FileKind;
}

const FileIcon = (props: FileIconProps) => {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.3,
    'stroke-linejoin': 'round' as const,
    'stroke-linecap': 'round' as const,
  };

  if (props.kind === 'folder') {
    return (
      <svg {...common}>
        <path d="M1.5 3.5h4l1.2 1.5h7.3v7.5a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1v-9z" />
      </svg>
    );
  }
  if (props.kind === 'folder-open') {
    return (
      <svg {...common}>
        <path d="M1.5 5.5v-2a1 1 0 0 1 1-1h3l1.2 1.5h6.3a1 1 0 0 1 1 1v.5" />
        <path d="M1.5 5.5h12.5l-1.4 6.6a1 1 0 0 1-1 .9h-8.7a1 1 0 0 1-1-.8l-1.4-6.7z" />
      </svg>
    );
  }
  if (props.kind === 'md') {
    return (
      <svg {...common}>
        <path d={DOC} />
        <path d={DOC_FOLD} />
        <path d="M5 11.5v-3l1.5 1.8L8 8.5v3" />
        <path d="M9.5 8.5v3l1.3-1.3" />
      </svg>
    );
  }
  if (props.kind === 'txt') {
    return (
      <svg {...common}>
        <path d={DOC} />
        <path d={DOC_FOLD} />
        <path d="M5 8.5h6M5 10.5h6M5 12h4" />
      </svg>
    );
  }
  if (props.kind === 'png') {
    return (
      <svg {...common}>
        <path d={DOC} />
        <path d={DOC_FOLD} />
        <circle cx="6" cy="8.5" r="0.9" />
        <path d="M4.5 12.5l2.3-2.5 1.7 1.8 1-1.2 1.5 1.9" />
      </svg>
    );
  }
  if (props.kind === 'svg') {
    return (
      <svg {...common}>
        <path d={DOC} />
        <path d={DOC_FOLD} />
        <path d="M5 12.5l2-4 2 4M9.5 8.5l2 4" />
      </svg>
    );
  }
  if (props.kind === 'pdf') {
    return (
      <svg {...common}>
        <path d={DOC} />
        <path d={DOC_FOLD} />
        <path d="M5 12.5v-4h1a1 1 0 0 1 0 2h-1" />
        <path d="M8.3 12.5v-4h1.2M8.3 10.5h1" />
        <path d="M11 12.5v-4h1.2" />
      </svg>
    );
  }
  if (props.kind === 'code') {
    return (
      <svg {...common}>
        <path d={DOC} />
        <path d={DOC_FOLD} />
        <path d="M6 8.5l-1.5 2 1.5 2M9 8.5l1.5 2-1.5 2" />
      </svg>
    );
  }
  if (props.kind === 'canvas') {
    return (
      <svg {...common}>
        <path d={DOC} />
        <path d={DOC_FOLD} />
        <path d="M4.5 8.5h6v4h-6z" />
        <path d="M4.5 10.5h6M7.5 8.5v4" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d={DOC} />
      <path d={DOC_FOLD} />
      <path d="M6 8.5v1.4l1-.7 1 1.4-1 .7v1.2" />
    </svg>
  );
};

export default FileIcon;
