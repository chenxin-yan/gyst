import { describe, expect, it } from "vite-plus/test";
import { buildCommandDocumentation, type CommandDocumentation } from "@crustjs/core/tooling";
import { ApplyEnvelopeSchema, ApplyOpSchema, ErrorCodeSchema } from "@gyst/core";

import packageJson from "../../package.json" with { type: "json" };
import { app } from "./app.ts";

const child = (node: CommandDocumentation, name: string) =>
  node.children.find((candidate) => candidate.name === name)!;
const sectionsOf = (node: CommandDocumentation) =>
  Object.fromEntries(node.sections.map(({ title, body }) => [title, body]));

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

  it("documents output, errors, the apply envelope and retries from the shared schemas", async () => {
    const session = child(buildCommandDocumentation(await app.snapshot()), "session");
    const output = sectionsOf(session)["Output and errors"]!;
    for (const code of ErrorCodeSchema.literals) expect(output).toContain(`\`${code}\``);

    const apply = sectionsOf(child(session, "apply"));
    for (const field of Object.keys(ApplyEnvelopeSchema.fields))
      expect(apply["Input"]).toContain(`"${field}"`);
    for (const { fields } of ApplyOpSchema.members)
      expect(apply["Input"]).toContain(`- \`${fields.type.literal}\``);
    expect(apply["Input"]).toContain(
      "- `group.create`: id, title, overview, memberHunkIds, files?",
    );

    for (const name of ["apply", "threads", "refresh", "delete"])
      expect(sectionsOf(child(session, name))["Retry"]).toMatch(/same/);
  });
});
