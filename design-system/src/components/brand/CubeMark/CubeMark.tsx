import { SVG_INVARIANTS } from "../../graphics/svg";

export interface CubeMarkProps {
  size?: number;
}

const CubeMark = (props: CubeMarkProps) => {
  const size = () => props.size ?? 24;
  return (
    <svg
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      stroke-width="1.6"
      {...SVG_INVARIANTS}
    >
      <path d="M12 2.5l8.5 4.9v9.2L12 21.5l-8.5-4.9V7.4z" />
      <path d="M3.5 7.4L12 12.3l8.5-4.9" />
      <path d="M12 12.3v9.2" />
    </svg>
  );
};

export default CubeMark;
