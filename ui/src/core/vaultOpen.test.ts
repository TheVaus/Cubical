import { describe, expect, it } from "vitest";

import { switchVault } from "./vaultOpen";

function recorder() {
  const steps: string[] = [];
  return { steps, mark: (s: string) => steps.push(s) };
}

describe("switchVault", () => {
  it("opens before it releases the session it is replacing", async () => {
    const { steps, mark } = recorder();
    const opened = await switchVault({
      open: async () => {
        mark("open");
        return "v2";
      },
      release: () => mark("release"),
      adopt: (id) => mark(`adopt:${id}`),
    });
    expect(steps).toEqual(["open", "release", "adopt:v2"]);
    expect(opened).toBe("v2");
  });

  it("keeps the current session when the open fails", async () => {
    const { steps, mark } = recorder();
    const failed = switchVault({
      open: () => Promise.reject(new Error("no such vault")),
      release: () => mark("release"),
      adopt: () => mark("adopt"),
    });
    await expect(failed).rejects.toThrow("no such vault");
    expect(steps).toEqual([]);
  });

  it("adopts before it returns, so the caller resumes on the new vault", async () => {
    let adopted: string | null = null;
    const opened = await switchVault({
      open: async () => "v2",
      release: () => {
        adopted = null;
      },
      adopt: (id) => {
        adopted = id;
      },
    });
    expect(adopted).toBe(opened);
  });
});
