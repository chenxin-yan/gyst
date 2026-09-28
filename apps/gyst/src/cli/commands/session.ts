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

const call = Effect.fn("session.call")(function* (
  request: Request,
  stdout: (line: string) => void,
) {
  const client = yield* DaemonClient;
  stdout(JSON.stringify(yield* client.request(request)));
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
        const patch = flags.stdin ? yield* readStdin : undefined;
        // Operands on either side of crust's `--` form one list; its own `--` starts the pathspecs.
        const operands = [...args.gitArgs, ...rawArgs];
        const separator = operands.indexOf("--");
        yield* call(
          {
            command: "create",
            cwd: process.cwd(),
            revisions: separator === -1 ? operands : operands.slice(0, separator),
            pathspecs: separator === -1 ? undefined : operands.slice(separator + 1),
            patch,
          },
          stdout,
        );
      }),
    ),
);
const status = defineCommand("status", { description: "Read session status" }, (command) =>
  command
    .use(daemonClient)
    .flags(sessionFlag)
    .action(
      handler(({ flags, stdout }) =>
        call({ command: "status", cwd: process.cwd(), session: flags.session }, stdout),
      ),
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
        handler(({ flags, stdout }) =>
          call({ command: "check", cwd: process.cwd(), session: flags.session }, stdout),
        ),
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
          {
            command: "diff",
            cwd: process.cwd(),
            session: flags.session,
            hunk: flags.hunk,
            group: flags.group,
            file: flags.file,
          },
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
          const batch = yield* readStdin;
          yield* call(
            { command: "apply", cwd: process.cwd(), session: flags.session, batch },
            stdout,
          );
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
          const patch = flags.stdin ? yield* readStdin : undefined;
          yield* call(
            { command: "refresh", cwd: process.cwd(), session: flags.session, patch },
            stdout,
          );
        }),
      ),
);
const close = defineCommand("close", { description: "Close a session" }, (command) =>
  command
    .use(daemonClient)
    .flags(sessionFlag)
    .action(
      handler(({ flags, stdout }) =>
        call({ command: "close", cwd: process.cwd(), session: flags.session }, stdout),
      ),
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
