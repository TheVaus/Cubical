import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { VAULT_EVENTS } from "./ipc";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../crates/cubical-engine/tests/fixtures/event_names.json",
);

describe("event names agree with cubical_engine::events", () => {
  it("listens for exactly the names the engine emits", () => {
    expect(VAULT_EVENTS).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
  });
});
