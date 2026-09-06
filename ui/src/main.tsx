import { render } from "solid-js/web";
import "katex/dist/katex.min.css";
import App from "./App";
import { installPerfConsole } from "./core/perf";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element #root not found in index.html");
}

installPerfConsole(window);

render(() => <App />, root);
