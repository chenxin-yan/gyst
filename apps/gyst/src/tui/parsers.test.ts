import { describe, expect, it } from "bun:test";
import { pathToFiletype } from "@opentui/core";
import { registerParsers } from "./parsers.ts";

describe("registerParsers", () => {
  it("resolves the files of every downloadable grammar OpenTUI does not know", () => {
    registerParsers();
    expect(
      Object.fromEntries(
        ["main.hcl", "main.tf", "prod.tfvars", "flake.nix", "Foo.agda"].map((path) => [
          path,
          pathToFiletype(path),
        ]),
      ),
    ).toEqual({
      "main.hcl": "hcl",
      "main.tf": "hcl",
      "prod.tfvars": "hcl",
      "flake.nix": "nix",
      "Foo.agda": "agda",
    });
  });
});
