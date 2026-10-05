import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import {
  AddonDiscoverySchema,
  AddonHandshakeSchema,
  AddonStateSchema,
  addonStateOf,
  navigationInstallCommand,
} from "./navigation.ts";

const strict = { onExcessProperty: "error" } as const;
const decodeDiscovery = Schema.decodeUnknownSync(AddonDiscoverySchema, strict);
const decodeState = Schema.decodeUnknownSync(AddonStateSchema, strict);
const install = "npm install -g @gyst/navigation-typescript@1.2.3";

describe("navigation add-on contract", () => {
  it("names the exact running version in the install instruction", () => {
    expect(navigationInstallCommand("1.2.3")).toBe(install);
  });

  it("accepts an available add-on only at an absolute entry", () => {
    const available = { kind: "available", entry: "/opt/addon/src/cli.js", version: "1.2.3" };
    expect(decodeDiscovery(available)).toEqual(available);
    for (const entry of ["src/cli.js", "./cli.js", ""])
      expect(() => decodeDiscovery({ ...available, entry })).toThrow();
  });

  it("decodes the handshake line, including a broken engine", () => {
    const decode = Schema.decodeUnknownSync(AddonHandshakeSchema, strict);
    const line = {
      name: "@gyst/navigation-typescript",
      version: "1.2.3",
      protocol: 1,
      engine: { ok: true, version: "7.0.2" },
    };
    expect(decode(line)).toEqual(line);
    expect(decode({ ...line, engine: { ok: false, problem: "no native binary" } }).engine).toEqual({
      ok: false,
      problem: "no native binary",
    });
    expect(() => decode({ ...line, engine: { ok: true } })).toThrow();
    expect(() => decode({ version: "1.2.3" })).toThrow();
  });

  it("gives the browser state the exact instruction and never the entry", () => {
    const states = [
      addonStateOf(
        { kind: "available", entry: "/opt/addon/src/cli.js", version: "1.2.3" },
        "1.2.3",
      ),
      addonStateOf({ kind: "missing" }, "1.2.3"),
      addonStateOf({ kind: "mismatched", found: "1.2.2" }, "1.2.3"),
      addonStateOf({ kind: "unusable", reason: "no handshake" }, "1.2.3"),
    ];
    expect(states).toEqual([
      { kind: "available", version: "1.2.3" },
      { kind: "missing", install },
      { kind: "mismatched", found: "1.2.2", install },
      { kind: "unusable", reason: "no handshake", install },
    ]);
    for (const state of states) {
      expect(decodeState(state)).toEqual(state);
      expect(JSON.stringify(state)).not.toContain("/opt/addon");
    }
    expect(() =>
      decodeState({ kind: "available", version: "1.2.3", entry: "/opt/addon/src/cli.js" }),
    ).toThrow();
  });
});
