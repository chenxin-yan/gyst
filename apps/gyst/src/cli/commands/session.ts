import { defineArg, defineCommand } from "@crustjs/core";
import { handler, layer } from "@crustjs/effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BadArgs, type Request } from "@gyst/core";
import { Effect, Layer, Stdio, Stream } from "effect";
import { DaemonClient } from "../../daemon/client.ts";
import { Paths } from "../../daemon/paths.ts";

const daemonClient = layer(
  "daemonClient",
  DaemonClient.layer.pipe(Layer.provide(Paths.layer), Layer.provideMerge(NodeServices.layer)),
);

const sessionFlag = {
  name: "session",
  type: "string",
  required: true,
  description: "The exact session id returned by `gyst session open`",
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

const open = defineCommand(
  "open",
  {
    description:
      "Open the session for uncommitted changes or a Git range, creating it only if none is saved; prints its identity without launching a viewer",
  },
  (command) =>
    command
      .use(daemonClient)
      .flags({
        name: "session",
        type: "string",
        description: "Open this exact saved session id instead of selecting by scope",
      })
      .args(
        defineArg("range", {
          type: "string",
          description: "A Git range such as main...feature; omitted, uncommitted changes",
        }),
      )
      .action(
        handler(function* ({ args, flags, rawArgs, stdout }) {
          if (rawArgs.length > 0)
            return yield* new BadArgs({ message: "session open takes at most one Git range" });
          if (flags.session !== undefined) {
            if (args.range !== undefined)
              return yield* new BadArgs({ message: "choose a Git range or --session, not both" });
            return yield* call({ command: "open", session: flags.session }, stdout);
          }
          yield* call(
            {
              command: "open",
              cwd: process.cwd(),
              scope:
                args.range === undefined
                  ? { kind: "uncommitted" }
                  : { kind: "range", range: args.range },
            },
            stdout,
          );
        }),
      ),
);
const list = defineCommand("list", { description: "List saved sessions" }, (command) =>
  command.use(daemonClient).action(handler(({ stdout }) => call({ command: "list" }, stdout))),
);
const status = defineCommand("status", { description: "Read session status" }, (command) =>
  command
    .use(daemonClient)
    .flags(sessionFlag)
    .action(
      handler(({ flags, stdout }) => call({ command: "status", session: flags.session }, stdout)),
    ),
);
const check = defineCommand(
  "check",
  { description: "Check the recorded scope without refreshing (cached up to 5 seconds)" },
  (command) =>
    command
      .use(daemonClient)
      .flags(sessionFlag)
      .action(
        handler(({ flags, stdout }) => call({ command: "check", session: flags.session }, stdout)),
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
          yield* call({ command: "apply", session: flags.session, batch }, stdout);
        }),
      ),
);
const refresh = defineCommand(
  "refresh",
  { description: "Recapture the recorded scope into a new snapshot" },
  (command) =>
    command
      .use(daemonClient)
      .flags(sessionFlag)
      .action(
        handler(({ flags, stdout }) =>
          call({ command: "refresh", session: flags.session }, stdout),
        ),
      ),
);
const remove = defineCommand(
  "delete",
  { description: "Delete one saved session and its review state" },
  (command) =>
    command
      .use(daemonClient)
      .flags(sessionFlag, {
        name: "request-id",
        type: "string",
        required: true,
        description:
          "A caller-chosen id for this deletion; reuse it with the same session to retry safely",
      })
      .action(
        handler(({ flags, stdout }) =>
          call(
            { command: "delete", session: flags.session, requestId: flags["request-id"] },
            stdout,
          ),
        ),
      ),
);

export const session = defineCommand(
  "session",
  { description: "Manage co-review sessions" },
  (command) =>
    command
      .provide(daemonClient())
      .add(open)
      .add(list)
      .add(status)
      .add(check)
      .add(diff)
      .add(apply)
      .add(refresh)
      .add(remove),
);
