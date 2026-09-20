import { describe, expect, it } from "bun:test";
import { buildCommandDocumentation } from "@crustjs/core/tooling";

import packageJson from "../../package.json" with { type: "json" };
import { app } from "./app.ts";

describe("app", () => {
  it("describes the root, session, and skills command tree", async () => {
    const snapshot = await app.snapshot();
    expect(buildCommandDocumentation(snapshot).children.map(({ name }) => name)).toEqual([
      "session",
      "skills",
    ]);
  });

  it("reports the package version in root metadata", async () => {
    expect((await app.snapshot()).meta.version).toBe(packageJson.version);
  });
});
