import { ErrorBoundary, type Component, type JSX } from "solid-js";

import Button from "@ds/components/forms/Button/Button";
import Callout from "@ds/components/feedback/Callout/Callout";

import { errorMessage } from "../errorMessage";

export interface FeatureBoundaryProps {
  feature: string;
  children: JSX.Element;
}

const FeatureBoundary: Component<FeatureBoundaryProps> = (props) => (
  <ErrorBoundary
    fallback={(err: unknown, reset: () => void) => {
      console.error(`${props.feature} failed`, err);
      return (
        <Callout tone="error" title={`${props.feature} stopped`}>
          <div
            style={{
              display: "flex",
              "align-items": "center",
              "justify-content": "space-between",
              gap: "var(--space-3)",
            }}
          >
            <span>{errorMessage(err)}</span>
            <Button variant="secondary" size="sm" onClick={reset}>
              Try again
            </Button>
          </div>
        </Callout>
      );
    }}
  >
    {props.children}
  </ErrorBoundary>
);

export default FeatureBoundary;
