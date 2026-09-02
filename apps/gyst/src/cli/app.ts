import {
  Crust,
  defineArg,
  defineCommand,
  defineExtension,
  defineExtensionId,
} from "@crustjs/core";
import { help, version } from "@crustjs/extensions";
import { ErrorPayloadSchema, type ErrorPayload } from "@gyst/core";
import { Schema } from "effect";
import packageJson from "../../package.json" with { type: "json" };

import { renderCompileSmoke } from "../tui/compile-smoke.tsx";
import { renderTui } from "../tui/render.tsx";
import { runSessionCli } from "./session.ts";

const sessionFlag = { name: "session", type: "string", description: "Select an exact session id" } as const;

function option(name: string, value: string | undefined): string[] {
  return value === undefined ? [] : [`--${name}`, value];
}

const create = defineCommand("create", { description: "Create a session" }, (command) =>
  command
    .flags({ name: "stdin", type: "boolean", description: "Read a unified diff from stdin" })
    .args(defineArg("gitArgs", { type: "string", variadic: true }))
    .action(({ args, flags, rawArgs }) => runSessionCli([
      "create",
      ...(flags.stdin ? ["--stdin"] : []),
      "--",
      ...args.gitArgs,
      ...rawArgs,
    ])),
);
const status = defineCommand("status", { description: "Read session status" }, (command) =>
  command.flags(sessionFlag).action(({ flags }) => runSessionCli(["status", ...option("session", flags.session)])),
);
const diff = defineCommand("diff", { description: "Read snapshot hunks" }, (command) =>
  command
    .flags(
      sessionFlag,
      { name: "hunk", type: "string" },
      { name: "group", type: "string" },
      { name: "file", type: "string" },
    )
    .action(({ flags }) => runSessionCli([
      "diff",
      ...option("session", flags.session),
      ...option("hunk", flags.hunk),
      ...option("group", flags.group),
      ...option("file", flags.file),
    ])),
);
const apply = defineCommand("apply", { description: "Apply one agent mutation batch from stdin" }, (command) =>
  command.flags(sessionFlag).action(({ flags }) => runSessionCli(["apply", ...option("session", flags.session)])),
);
const refresh = defineCommand("refresh", { description: "Refresh the session snapshot" }, (command) =>
  command
    .flags(sessionFlag, { name: "stdin", type: "boolean", description: "Read the replacement unified diff from stdin" })
    .action(({ flags }) => runSessionCli(["refresh", ...option("session", flags.session), ...(flags.stdin ? ["--stdin"] : [])])),
);
const close = defineCommand("close", { description: "Close a session" }, (command) =>
  command.flags(sessionFlag).action(({ flags }) => runSessionCli(["close", ...option("session", flags.session)])),
);

const session = defineCommand("session", { description: "Manage a co-review session" }, (command) =>
  command.add(create).add(status).add(diff).add(apply).add(refresh).add(close),
);

const jsonErrors = defineExtension(defineExtensionId("gyst-json-errors"), {
  hooks: {
    onError(cause, { stderr }) {
      let error: ErrorPayload;
      try { error = Schema.decodeUnknownSync(ErrorPayloadSchema)(cause); }
      catch { error = { code: "bad_args", message: cause instanceof Error ? cause.message : "invalid command" }; }
      stderr(JSON.stringify(error));
      return true;
    },
  },
});

export const app = new Crust("gyst", { description: "Keyboard-centric agent/human co-review" })
  .extend(jsonErrors)
  .extend(help())
  .extend(version(packageJson.version))
  .add(session)
  .action(async () => {
    if (process.env.GYST_COMPILE_SMOKE === "1") return renderCompileSmoke();
    await renderTui();
  });
