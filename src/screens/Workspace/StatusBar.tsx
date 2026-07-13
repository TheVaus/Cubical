import './StatusBar.css';

export interface StatusBarProps {
  wordCount: number;
  noteTitle: string;
}

const StatusBar = (props: StatusBarProps) => {
  return (
    <footer class="status-bar row eyebrow">
      <span>{props.noteTitle}</span>
      <span>{props.wordCount} words</span>
    </footer>
  );
};

export default StatusBar;
