import { defineArg, defineCommand } from "@crustjs/core";
import { handler, layer } from "@crustjs/effect";
import { BunServices } from "@effect/platform-bun";
import type { Request } from "@gyst/core";
import { Effect, Layer, Stdio, Stream } from "effect";
import { DaemonClient } from "../../daemon/client.ts";
import { Paths } from "../../daemon/paths.ts";

const daemonClient = layer(
  "daemonClient",
  DaemonClient.layer.pipe(Layer.provide(Paths.layer), Layer.provideMerge(BunServices.layer)),
);

const sessionFlag = {
  name: "session",
  type: "string",
  description: "Select an exact session id",
} as const;

const option = (name: string, value: string | undefined): string[] =>
  value === undefined ? [] : [`--${name}`, value];

const call = Effect.fn("session.call")(function* (
  command: Request["command"],
  args: string[],
  stdout: (line: string) => void,
  stdin?: string,
) {
  const client = yield* DaemonClient;
  const value = yield* client.request({ command, cwd: process.cwd(), args, stdin });
  stdout(JSON.stringify(value));
});

const readStdin = Effect.flatMap(Stdio.Stdio, (stdio) =>
  stdio.stdin.pipe(Stream.decodeText(), Stream.mkString),
);

const create = defineCommand("create", { description: "Create a session" }, (command) =>
  command
    .use(daemonClient)
    .flags({
      name: "stdin",
      type: "boolean",
      description: "Read a unified diff with repository-root-relative paths from stdin",
    })
    .args(
      defineArg("gitArgs", {
        type: "string",
        variadic: true,
        description: "Git revisions, then `--` and pathspecs; git options are rejected",
      }),
    )
    .action(
      handler(function* ({ args, flags, rawArgs, stdout }) {
        const stdin = flags.stdin ? yield* readStdin : undefined;
        yield* call(
          "create",
          [...(flags.stdin ? ["--stdin"] : []), "--", ...args.gitArgs, ...rawArgs],
          stdout,
          stdin,
        );
      }),
    ),
);
const status = defineCommand("status", { description: "Read session status" }, (command) =>
  command
    .use(daemonClient)
    .flags(sessionFlag)
    .action(
      handler(({ flags, stdout }) => call("status", option("session", flags.session), stdout)),
    ),
);
const check = defineCommand(
  "check",
  { description: "Check the recorded source without refreshing (cached up to 5 seconds)" },
  (command) =>
    command
      .use(daemonClient)
      .flags(sessionFlag)
      .action(
        handler(({ flags, stdout }) => call("check", option("session", flags.session), stdout)),
      ),
);
const diff = defineCommand("diff", { description: "Read snapshot hunks" }, (command) =>
  command
    .use(daemonClient)
    .flags(
      sessionFlag,
      { name: "hunk", type: "string" },
      { name: "group", type: "string" },
      { name: "file", type: "string" },
    )
    .action(
      handler(({ flags, stdout }) =>
        call(
          "diff",
          [
            ...option("session", flags.session),
            ...option("hunk", flags.hunk),
            ...option("group", flags.group),
            ...option("file", flags.file),
          ],
          stdout,
        ),
      ),
    ),
);
const apply = defineCommand(
  "apply",
  { description: "Apply one agent mutation batch from stdin" },
  (command) =>
    command
      .use(daemonClient)
      .flags(sessionFlag)
      .action(
        handler(function* ({ flags, stdout }) {
          yield* call("apply", option("session", flags.session), stdout, yield* readStdin);
        }),
      ),
);
const refresh = defineCommand(
  "refresh",
  { description: "Refresh the session snapshot" },
  (command) =>
    command
      .use(daemonClient)
      .flags(sessionFlag, {
        name: "stdin",
        type: "boolean",
        description: "Read the replacement unified diff from stdin",
      })
      .action(
        handler(function* ({ flags, stdout }) {
          const stdin = flags.stdin ? yield* readStdin : undefined;
          yield* call(
            "refresh",
            [...option("session", flags.session), ...(flags.stdin ? ["--stdin"] : [])],
            stdout,
            stdin,
          );
        }),
      ),
);
const close = defineCommand("close", { description: "Close a session" }, (command) =>
  command
    .use(daemonClient)
    .flags(sessionFlag)
    .action(
      handler(({ flags, stdout }) => call("close", option("session", flags.session), stdout)),
    ),
);

export const session = defineCommand(
  "session",
  { description: "Manage a co-review session" },
  (command) =>
    command
      .provide(daemonClient())
      .add(create)
      .add(status)
      .add(check)
      .add(diff)
      .add(apply)
      .add(refresh)
      .add(close),
);
