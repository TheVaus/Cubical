import SegmentedControl from "@ds/components/forms/SegmentedControl/SegmentedControl";

export interface OnOffControlProps {
  value: boolean;
  onChange: (value: boolean) => void;
}

const OnOffControl = (props: OnOffControlProps) => (
  <SegmentedControl
    variant="pill"
    role="radiogroup"
    options={[
      { label: "Off", value: "off" },
      { label: "On", value: "on" },
    ]}
    value={props.value ? "on" : "off"}
    onChange={(v) => props.onChange(v === "on")}
  />
);

export default OnOffControl;
