import { Schema } from "effect";

/**
 * The optional TS/JS navigation add-on. Its release version always equals gyst's, so the running
 * version is the only one the daemon accepts and the one every install instruction names.
 */
export const navigationAddon = {
  name: "@gyst/navigation-typescript",
  bin: "gyst-navigation-typescript",
  /** The `--version` handshake and `lsp --expect` contract this gyst speaks. */
  protocol: 1,
} as const;

/** The global install (or update) a human runs to get the add-on matching this gyst. */
export const navigationInstallCommand = (version: string) =>
  `npm install -g ${navigationAddon.name}@${version}`;

/**
 * The one JSON line `gyst-navigation-typescript --version` prints. `name` and `protocol` stay
 * loose so a foreign or future executable decodes far enough to be refused for the right reason.
 */
export const AddonHandshakeSchema = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  protocol: Schema.Number,
  /** The result of actually running the add-on's own pinned engine, not its declared version. */
  engine: Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), version: Schema.String }),
    Schema.Struct({ ok: Schema.Literal(false), problem: Schema.String }),
  ]),
});
export type AddonHandshake = typeof AddonHandshakeSchema.Type;

/** Discovery runs on POSIX hosts only, so a host path is absolute when it starts at the root. */
const AbsolutePathSchema = Schema.String.check(
  Schema.makeFilter((path) => path.startsWith("/") || "expected an absolute path"),
);

/**
 * What the daemon found on the PATH a session was last opened with. `entry` is the resolved real
 * path of the add-on's executable script, which the daemon runs with its own Node.
 */
export const AddonDiscoverySchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("available"),
    entry: AbsolutePathSchema,
    version: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("missing") }),
  /** A working add-on of another release; `found` is the version it reported. */
  Schema.Struct({ kind: Schema.Literal("mismatched"), found: Schema.String }),
  /** Found but not usable: no valid handshake, a foreign executable or a broken engine. */
  Schema.Struct({ kind: Schema.Literal("unusable"), reason: Schema.String }),
]);
export type AddonDiscovery = typeof AddonDiscoverySchema.Type;

/**
 * The add-on as a browser sees it: never its host path, and with the exact install or update
 * instruction whenever navigation cannot run.
 */
export const AddonStateSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("available"), version: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("missing"), install: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("mismatched"),
    found: Schema.String,
    install: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("unusable"),
    reason: Schema.String,
    install: Schema.String,
  }),
]);
export type AddonState = typeof AddonStateSchema.Type;

export const addonStateOf = (discovery: AddonDiscovery, runningVersion: string): AddonState => {
  const install = navigationInstallCommand(runningVersion);
  switch (discovery.kind) {
    case "available":
      return { kind: "available", version: discovery.version };
    case "missing":
      return { kind: "missing", install };
    case "mismatched":
      return { kind: "mismatched", found: discovery.found, install };
    case "unusable":
      return { kind: "unusable", reason: discovery.reason, install };
  }
};
