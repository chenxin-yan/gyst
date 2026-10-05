import {
  GitObjectIdSchema,
  type GitHubUnavailableReason,
  type PullRequest,
  PullRequestNumberSchema,
  type PullRequestScope,
  pullRequestUrlOf,
  SourceUnavailable,
  type StackMembership,
  StackMembershipSchema,
} from "@gyst/core";
import { Context, Data, Effect, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { diagnostics } from "./git.ts";

/** One stack discovery: GitHub's explicit answer, or why there is none. Never inferred. */
export type StackDiscovery =
  | { readonly ok: true; readonly membership: StackMembership }
  | { readonly ok: false; readonly reason: GitHubUnavailableReason };

// Separate queries: a host whose schema lacks stack fields can still open the PR itself.
const pullRequestFields = "number title body state url baseRefName headRefName";
const variables = "$owner:String!,$repo:String!,$number:Int!";
const pullRequestQuery = `query(${variables}){repository(owner:$owner,name:$repo){pullRequest(number:$number){${pullRequestFields} headRefOid}}}`;
// A stack larger than one page is reported unavailable rather than partial.
const stackQuery = `query(${variables}){repository(owner:$owner,name:$repo){pullRequest(number:$number){number stack{number size baseRefName entries(first:100){totalCount nodes{position pullRequest{${pullRequestFields}}}}}}}}`;

const GitHubPullRequestSchema = Schema.Struct({
  number: PullRequestNumberSchema,
  title: Schema.String,
  body: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  url: Schema.String,
  baseRefName: Schema.String,
  headRefName: Schema.String,
});
/** `gh api graphql` stdout: GraphQL data and errors, or a REST-style error such as a bad token. */
const response = <A extends Schema.Top>(pullRequest: A) =>
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            repository: Schema.NullOr(Schema.Struct({ pullRequest: Schema.NullOr(pullRequest) })),
          }),
        ),
      ),
      errors: Schema.optional(
        Schema.Array(
          Schema.Struct({
            type: Schema.optional(Schema.String),
            message: Schema.optional(Schema.String),
          }),
        ),
      ),
      message: Schema.optional(Schema.String),
      status: Schema.optional(Schema.String),
    }),
  );
const decodePullRequestResponse = Schema.decodeUnknownOption(
  response(Schema.Struct({ ...GitHubPullRequestSchema.fields, headRefOid: GitObjectIdSchema })),
);
const decodeStackResponse = Schema.decodeUnknownOption(
  response(
    Schema.Struct({
      number: PullRequestNumberSchema,
      stack: Schema.NullOr(
        Schema.Struct({
          number: PullRequestNumberSchema,
          size: Schema.Natural,
          baseRefName: Schema.String,
          entries: Schema.Struct({
            totalCount: Schema.Natural,
            nodes: Schema.Array(
              Schema.NullOr(
                Schema.Struct({
                  position: PullRequestNumberSchema,
                  pullRequest: Schema.NullOr(GitHubPullRequestSchema),
                }),
              ),
            ),
          }),
        }),
      ),
    }),
  ),
);
type Reply = {
  readonly errors?:
    | ReadonlyArray<{ readonly type?: string | undefined; readonly message?: string | undefined }>
    | undefined;
  readonly message?: string | undefined;
  readonly status?: string | undefined;
};

const isMembership = Schema.is(StackMembershipSchema);
const pullRequestOf = ({ body, state, ...rest }: typeof GitHubPullRequestSchema.Type) =>
  ({
    ...rest,
    description: body,
    state: state === "OPEN" ? "open" : state === "MERGED" ? "merged" : "closed",
  }) satisfies PullRequest;

class GhFailed extends Data.TaggedError("GhFailed")<{
  readonly reason: GitHubUnavailableReason;
  readonly diagnostic?: string;
}> {}

type GhOutput = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
/** Exit 4 is gh's "authentication required"; 401 is a rejected token. */
const failureOf = (output: GhOutput, reply: Reply | undefined) => {
  const said = [output.stderr, reply?.message ?? "", ...(reply?.errors ?? []).map((e) => e.message)]
    .join("\n")
    .trim();
  const reason: GitHubUnavailableReason =
    output.exitCode === 4 || reply?.status === "401" || /\bHTTP 401\b/.test(output.stderr)
      ? "gh_unauthenticated"
      : /rate limit/i.test(said)
        ? "github_failed"
        : (reply?.errors ?? []).some(({ type }) => type === "NOT_FOUND" || type === "FORBIDDEN") ||
            reply?.status === "403" ||
            reply?.status === "404" ||
            /\bHTTP 40[34]\b/.test(output.stderr)
          ? "no_access"
          : "github_failed";
  return new GhFailed({ reason, ...(said && { diagnostic: said }) });
};

const messages: Record<GitHubUnavailableReason, (url: string) => string> = {
  gh_missing: () =>
    "GitHub CLI (gh) is not installed on the gyst host: install it, run gh auth login, then open the PR again",
  gh_unauthenticated: () =>
    "gh is not signed in to github.com on the gyst host: run gh auth login (or set GH_TOKEN), then open the PR again",
  no_access: (url) => `${url} was not found or is not readable by the gyst host's gh account`,
  github_failed: (url) => `GitHub could not be asked about ${url}; try again later`,
};
const unavailable = (scope: PullRequestScope, { reason, diagnostic }: GhFailed) =>
  new SourceUnavailable({
    message: messages[reason](pullRequestUrlOf(scope)),
    detail: { reason, ...(diagnostic !== undefined && { diagnostic }) },
  });

/** Reads github.com through the host's authenticated `gh`; never prompts, never writes. */
export class GitHub extends Context.Service<
  GitHub,
  {
    /** The PR's metadata and the head commit its range must be captured at. */
    pullRequest(
      scope: PullRequestScope,
    ): Effect.Effect<{ pullRequest: PullRequest; headRefOid: string }, SourceUnavailable>;
    /**
     * Native stack membership. Only an explicit `stack: null` in a successful answer is `none`;
     * any failure, partial or inconsistent answer is unavailable.
     */
    stack(scope: PullRequestScope): Effect.Effect<StackDiscovery>;
  }
>()("gyst/daemon/GitHub") {
  static readonly layer = Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const gh = Effect.fn("GitHub.gh")(
        function* (scope: PullRequestScope, query: string) {
          const [owner, repo] = scope.repository.split("/");
          const handle = yield* spawner.spawn(
            ChildProcess.make(
              "gh",
              [
                "api",
                "graphql",
                "--hostname",
                "github.com",
                "-f",
                `owner=${owner}`,
                "-f",
                `repo=${repo}`,
                "-F",
                `number=${scope.number}`,
                "-f",
                `query=${query}`,
              ],
              {
                env: {
                  GH_PROMPT_DISABLED: "1",
                  GH_NO_UPDATE_NOTIFIER: "1",
                  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
                  NO_COLOR: "1",
                },
                extendEnv: true,
                stdin: "ignore",
                forceKillAfter: "500 millis",
              },
            ),
          );
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.stdout)),
              diagnostics(handle.stderr),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          return { exitCode, stdout, stderr } satisfies GhOutput;
        },
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: "20 seconds",
          orElse: () =>
            Effect.fail(new GhFailed({ reason: "github_failed", diagnostic: "gh timed out" })),
        }),
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new GhFailed({
              reason:
                error.reason._tag === "NotFound" && error.reason.method === "spawn"
                  ? "gh_missing"
                  : "github_failed",
              diagnostic: error.message,
            }),
          ),
        ),
      );

      const pullRequest = Effect.fn("GitHub.pullRequest")(function* (scope: PullRequestScope) {
        const output = yield* gh(scope, pullRequestQuery).pipe(
          Effect.mapError((failure) => unavailable(scope, failure)),
        );
        const reply = Option.getOrUndefined(decodePullRequestResponse(output.stdout));
        const found = reply?.data?.repository?.pullRequest;
        if (
          output.exitCode !== 0 ||
          reply?.errors?.length ||
          !found ||
          found.number !== scope.number
        )
          return yield* unavailable(scope, failureOf(output, reply));
        const { headRefOid, ...rest } = found;
        return { pullRequest: pullRequestOf(rest), headRefOid };
      });

      const stack = Effect.fn("GitHub.stack")(function* (scope: PullRequestScope) {
        const output = yield* gh(scope, stackQuery);
        const reply = Option.getOrUndefined(decodeStackResponse(output.stdout));
        const found = reply?.data?.repository?.pullRequest;
        if (
          output.exitCode !== 0 ||
          reply?.errors?.length ||
          !found ||
          found.number !== scope.number
        )
          return yield* failureOf(output, reply);
        if (found.stack === null)
          return { ok: true, membership: { membership: "none" } } satisfies StackDiscovery;
        const { number, size, baseRefName, entries } = found.stack;
        const layers = entries.nodes
          .flatMap((node) =>
            node?.pullRequest
              ? [{ position: node.position, pullRequest: pullRequestOf(node.pullRequest) }]
              : [],
          )
          .sort((a, b) => a.position - b.position);
        const membership = { membership: "stacked", number, baseRefName, layers } as const;
        if (
          entries.totalCount !== size ||
          layers.length !== size ||
          !isMembership(membership) ||
          !layers.some((layer) => layer.pullRequest.number === scope.number)
        )
          return yield* new GhFailed({ reason: "github_failed" });
        return { ok: true, membership } satisfies StackDiscovery;
      });

      return GitHub.of({
        pullRequest,
        stack: (scope) =>
          stack(scope).pipe(
            Effect.catchTag("GhFailed", ({ reason }) =>
              Effect.succeed({ ok: false, reason } satisfies StackDiscovery),
            ),
          ),
      });
    }),
  );
}
