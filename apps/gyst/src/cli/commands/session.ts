import { defineArg, defineCommand } from "@crustjs/core";
import { handler, layer } from "@crustjs/effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BadArgs,
  type CaptureProgress,
  parsePullRequestUrl,
  type Request,
  RequestSchema,
  type Scope,
} from "@gyst/core";
import { Effect, Layer, Schema, Stdio, Stream } from "effect";
import { DaemonClient } from "../../daemon/client.ts";
import { checkoutRepository } from "../../daemon/github.ts";
import { Paths } from "../../daemon/paths.ts";

export const daemonClient = layer(
  "daemonClient",
  DaemonClient.layer.pipe(Layer.provide(Paths.layer), Layer.provideMerge(NodeServices.layer)),
);

/** The positional's description, shared by the root launch and `session open`. */
export const scopeArgDescription =
  "A Git range such as main...feature; omitted, uncommitted changes";

/** `--pr`, shared by the root launch and `session open`. */
export const prFlag = {
  name: "pr",
  type: "string",
  description:
    "A GitHub PR: its number in this checkout's repository, or a URL such as https://github.com/owner/name/pull/123",
} as const;

/** A Git range. A URL is refused rather than read as a range: PRs have their own argument. */
export const scopeOf = (target: string | undefined): Effect.Effect<Scope, BadArgs> => {
  if (target === undefined) return Effect.succeed({ kind: "uncommitted" });
  if (/^https?:\/\//iu.test(target))
    return Effect.fail(
      new BadArgs({
        message: "expected a Git range such as main...feature; pass a GitHub PR with --pr",
        detail: target,
      }),
    );
  return Effect.succeed({ kind: "range", range: target });
};

/** A PR URL, or a PR number in the repository `gh` resolves for the current checkout. */
const pullRequestScopeOf = Effect.fn("pullRequestScopeOf")(function* (target: string) {
  const fromUrl = parsePullRequestUrl(target);
  if (fromUrl) return fromUrl;
  const number = Number(target);
  if (!/^[1-9][0-9]*$/u.test(target) || !Number.isSafeInteger(number))
    return yield* new BadArgs({
      message:
        "expected a PR number or a GitHub PR URL such as https://github.com/owner/name/pull/123",
      detail: target,
    });
  const repository = yield* checkoutRepository(process.cwd());
  return { kind: "pr", repository, number } satisfies Scope;
});

type OpenRequest = Extract<Request, { command: "open" }>;

/** The open request `gyst` and `session open` both build from a Git range, `--pr` or `--session`. */
export const openRequestOf = Effect.fn("openRequestOf")(function* (target: {
  readonly range: string | undefined;
  readonly pr: string | undefined;
  readonly session: string | undefined;
}) {
  if ([target.range, target.pr, target.session].filter((given) => given !== undefined).length > 1)
    return yield* new BadArgs({ message: "choose one of a Git range, --pr or --session" });
  if (target.session !== undefined)
    return { command: "open", session: target.session } satisfies OpenRequest;
  return {
    command: "open",
    cwd: process.cwd(),
    scope:
      target.pr !== undefined ? yield* pullRequestScopeOf(target.pr) : yield* scopeOf(target.range),
  } satisfies OpenRequest;
});

const sessionFlag = {
  name: "session",
  type: "string",
  required: true,
  description: "The exact session id returned by `gyst session open`",
} as const;

const snapshotFlag = {
  name: "snapshot",
  type: "string",
  required: true,
  description: "The session's current snapshot id, from `open`, `status` or `diff`",
} as const;

const units = ["B", "KiB", "MiB", "GiB", "TiB"];
const byteSize = (bytes: number) => {
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024;
    unit++;
  }
  return `${unit === 0 ? bytes : bytes.toFixed(1)} ${units[unit]}`;
};

/**
 * Capture progress rewritten in place on a terminal `stream` (stderr), cleared once the request
 * settles; undefined when `stream` is not a terminal, so agents and pipes see nothing.
 */
export const terminalProgress = (stream: {
  readonly isTTY?: boolean | undefined;
  write(text: string): unknown;
}) => {
  if (!stream.isTTY) return undefined;
  let shown = false;
  return {
    report: (progress: CaptureProgress) =>
      Effect.sync(() => {
        shown = true;
        const work = progress.phase === "capture" ? "Capturing files" : "Diffing changed files";
        stream.write(
          `\r\x1b[Kgyst: ${work} ${progress.done}/${progress.total} (${byteSize(progress.bytes)} captured)`,
        );
      }),
    clear: Effect.sync(() => {
      if (shown) stream.write("\r\x1b[K");
      shown = false;
    }),
  };
};
export type TerminalProgress = NonNullable<ReturnType<typeof terminalProgress>>;

// Flags are checked here against the one shared request schema, so a bad value is a clear
// `bad_args` rather than a request the daemon rejects as malformed.
const decodeRequest = Schema.decodeUnknownEffect(RequestSchema, { onExcessProperty: "error" });

const call = Effect.fn("session.call")(function* (
  input: Request,
  stdout: (line: string) => void,
  progress?: TerminalProgress,
) {
  const request = yield* decodeRequest(input).pipe(
    Effect.mapError((error) => new BadArgs({ message: "invalid flags", detail: error.message })),
  );
  const client = yield* DaemonClient;
  const reply = yield* client
    .request(request, progress?.report)
    .pipe(Effect.ensuring(progress?.clear ?? Effect.void));
  stdout(JSON.stringify(reply));
});

const readStdin = Effect.flatMap(Stdio.Stdio, (stdio) =>
  stdio.stdin.pipe(Stream.decodeText(), Stream.mkString),
);

const open = defineCommand(
  "open",
  {
    description:
      "Open the session for uncommitted changes, a Git range or a GitHub PR, creating it only if none is saved; prints its identity without launching a viewer",
  },
  (command) =>
    command
      .use(daemonClient)
      .flags(
        {
          name: "session",
          type: "string",
          description: "Open this exact saved session id instead of selecting by scope",
        },
        prFlag,
      )
      .args(defineArg("range", { type: "string", description: scopeArgDescription }))
      .action(
        handler(function* ({ args, flags, rawArgs, stdout }) {
          if (rawArgs.length > 0)
            return yield* new BadArgs({ message: "session open takes at most one Git range" });
          const request = yield* openRequestOf({
            range: args.range,
            pr: flags.pr,
            session: flags.session,
          });
          yield* call(
            request,
            stdout,
            "cwd" in request ? terminalProgress(process.stderr) : undefined,
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
      .flags(sessionFlag, {
        name: "stack",
        type: "boolean",
        description:
          "Recheck a PR session's native GitHub stack metadata instead; never refreshes code or review state",
      })
      .action(
        handler(({ flags, stdout }) =>
          call({ command: flags.stack ? "stack" : "check", session: flags.session }, stdout),
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
const files = defineCommand(
  "files",
  { description: "List one page of the current snapshot's captured files and their sides" },
  (command) =>
    command
      .use(daemonClient)
      .flags(sessionFlag, snapshotFlag, {
        name: "after",
        type: "string",
        description: "Continue after this path: the previous page's `next`",
      })
      .action(
        handler(({ flags, stdout }) =>
          call(
            {
              command: "files",
              session: flags.session,
              snapshotId: flags.snapshot,
              after: flags.after,
            },
            stdout,
          ),
        ),
      ),
);
const code = defineCommand(
  "code",
  { description: "Read one page of a captured file's exact text from the current snapshot" },
  (command) =>
    command
      .use(daemonClient)
      .flags(
        sessionFlag,
        snapshotFlag,
        { name: "file", type: "string", required: true, description: "A path from `files`" },
        { name: "side", type: "string", required: true, description: "`old` or `new`" },
        { name: "start-line", type: "number", description: "First line (1-based); default 1" },
        {
          name: "offset",
          type: "number",
          description: "Continue at a previous page's `next.offset` instead of a start line",
        },
        { name: "end-line", type: "number", description: "Last line to read (inclusive)" },
      )
      .action(
        handler(({ flags, stdout }) =>
          call(
            {
              command: "code",
              session: flags.session,
              snapshotId: flags.snapshot,
              file: flags.file,
              side: flags.side as "old" | "new",
              startLine: flags["start-line"],
              offset: flags.offset,
              endLine: flags["end-line"],
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
          call(
            { command: "refresh", session: flags.session },
            stdout,
            terminalProgress(process.stderr),
          ),
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
      .add(files)
      .add(code)
      .add(apply)
      .add(refresh)
      .add(remove),
);
