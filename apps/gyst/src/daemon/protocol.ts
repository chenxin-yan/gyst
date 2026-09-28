import { RequestSchema } from "@gyst/core";
import { Schema } from "effect";
import { valid } from "semver";
import packageJson from "../../package.json" with { type: "json" };

export const daemonVersion = packageJson.version;
const VersionSchema = Schema.String.check(
  Schema.makeFilter((value) => valid(value) !== null || "expected a semantic version"),
);

export const DaemonInfoSchema = Schema.Struct({
  version: VersionSchema,
  instanceId: Schema.String,
});
export const RestartReplySchema = Schema.Struct({ restarting: Schema.Boolean });
export const DaemonMessageSchema = Schema.Union([
  Schema.Struct({ command: Schema.Literal("daemon.info") }),
  Schema.Struct({
    command: Schema.Literal("daemon.restart"),
    version: VersionSchema,
    instanceId: Schema.String,
    fingerprint: Schema.String,
  }),
  Schema.Struct({
    version: VersionSchema,
    instanceId: Schema.String,
    request: RequestSchema,
  }),
]);
