import { Schema } from "effect";
import type { Session } from "./session.ts";

/**
 * `owner/name` on github.com, lowercased: GitHub names are case-insensitive, so one repository has
 * one spelling. Each part is also a valid Git ref component, since it names private refs.
 */
export const RepositorySchema = Schema.String.check(
  Schema.makeFilter((repository) => {
    const [owner, name, ...rest] = repository.split("/");
    return (
      (rest.length === 0 &&
        owner !== undefined &&
        /^[a-z0-9-]+$/.test(owner) &&
        name !== undefined &&
        /^[a-z0-9_.-]+$/.test(name) &&
        !name.startsWith(".") &&
        !name.includes("..") &&
        !name.endsWith(".lock")) ||
      "repository must be a lowercase GitHub owner/name"
    );
  }),
);
export type Repository = typeof RepositorySchema.Type;

export const PullRequestNumberSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * A GitHub pull request reviewed as its own session: the repository plus PR is its identity,
 * whatever its current head, base or stack position. Its range resolves again at each capture.
 */
export const PullRequestScopeSchema = Schema.Struct({
  kind: Schema.Literal("pr"),
  repository: RepositorySchema,
  number: PullRequestNumberSchema,
});
export type PullRequestScope = typeof PullRequestScopeSchema.Type;

const isRepository = Schema.is(RepositorySchema);
const pullRequestUrlPattern =
  /^https:\/\/github\.com\/(?<owner>[^/?#]+)\/(?<name>[^/?#]+)\/pull\/(?<number>[1-9][0-9]*)(?:[/?#].*)?$/su;

/** Only `https://github.com/<owner>/<name>/pull/<n>`, optionally followed by a path, query or fragment. */
export const parsePullRequestUrl = (text: string): PullRequestScope | undefined => {
  const parts = pullRequestUrlPattern.exec(text)?.groups;
  if (!parts) return undefined;
  const repository = `${parts.owner}/${parts.name}`.toLowerCase();
  const number = Number(parts.number);
  return isRepository(repository) && Number.isSafeInteger(number)
    ? { kind: "pr", repository, number }
    : undefined;
};

export const pullRequestUrlOf = (scope: PullRequestScope) =>
  `https://github.com/${scope.repository}/pull/${scope.number}`;

export const PullRequestStateSchema = Schema.Literals(["open", "closed", "merged"]);

/** What GitHub last reported about one PR: display and relationship context, never review state. */
export const PullRequestSchema = Schema.Struct({
  number: PullRequestNumberSchema,
  title: Schema.String,
  description: Schema.String,
  state: PullRequestStateSchema,
  url: Schema.String,
  baseRefName: Schema.String,
  headRefName: Schema.String,
});
export type PullRequest = typeof PullRequestSchema.Type;

/** One PR of a native stack; position 1 is the bottom layer. */
export const StackLayerSchema = Schema.Struct({
  position: PullRequestNumberSchema,
  pullRequest: PullRequestSchema,
});
export type StackLayer = typeof StackLayerSchema.Type;

const noneFields = { membership: Schema.Literal("none") };
/** GitHub's explicit, linear membership; gyst never derives one from branch names or bases. */
const stackedFields = {
  membership: Schema.Literal("stacked"),
  number: PullRequestNumberSchema,
  baseRefName: Schema.String,
  layers: Schema.Array(StackLayerSchema),
};
const orderedLayers = <T extends { readonly layers: ReadonlyArray<StackLayer> }>() =>
  Schema.makeFilter<T>(
    ({ layers }) =>
      (layers.length > 0 &&
        layers.every(({ position }, index) => position === index + 1) &&
        new Set(layers.map(({ pullRequest }) => pullRequest.number)).size === layers.length) ||
      "stack layers must be distinct PRs at positions 1..n in order",
  );

/** Whether a PR is in a native stack, as a successful discovery answered it. */
export const StackMembershipSchema = Schema.Union([
  Schema.Struct(noneFields),
  Schema.Struct(stackedFields).check(orderedLayers()),
]);
export type StackMembership = typeof StackMembershipSchema.Type;

/** The GitHub-side reasons a source is unavailable; Git-side reasons are added in `errors.ts`. */
export const GitHubUnavailableReasonSchema = Schema.Literals([
  "gh_missing",
  "gh_unauthenticated",
  "no_access",
  "github_failed",
]);
export type GitHubUnavailableReason = typeof GitHubUnavailableReasonSchema.Type;

const pullRequestContextFields = {
  pullRequest: PullRequestSchema,
  stack: Schema.NullOr(
    Schema.Union([
      Schema.Struct({ verifiedAt: Schema.String, ...noneFields }),
      Schema.Struct({ verifiedAt: Schema.String, ...stackedFields }).check(orderedLayers()),
    ]),
  ),
  unavailable: Schema.NullOr(
    Schema.Struct({ at: Schema.String, reason: GitHubUnavailableReasonSchema }),
  ),
};
type PullRequestContextFields = Schema.Struct.Type<typeof pullRequestContextFields>;
const discoveryOutcome = <T extends PullRequestContextFields>() =>
  Schema.makeFilter<T>(
    ({ stack, unavailable }) =>
      stack !== null ||
      unavailable !== null ||
      "stack discovery has neither a result nor a failure",
  );
const stackContainsPullRequest = <T extends PullRequestContextFields>() =>
  Schema.makeFilter<T>(
    ({ pullRequest, stack }) =>
      stack?.membership !== "stacked" ||
      stack.layers.some((layer) => layer.pullRequest.number === pullRequest.number) ||
      "a discovered stack must contain its PR",
  );

/**
 * A PR session's GitHub context, kept apart from its snapshot. `stack` is the last successful
 * discovery and when it happened; `unavailable` is the latest attempt when it failed. A failure
 * never replaces `stack`, so unknown membership cannot read as verified removal or as fresh.
 */
export const PullRequestContextSchema = Schema.Struct(pullRequestContextFields).check(
  discoveryOutcome(),
  stackContainsPullRequest(),
);
export type PullRequestContext = typeof PullRequestContextSchema.Type;

/**
 * A PR session's status context: its GitHub context, the selected PR, and the saved sessions of
 * the selected PR and its known layers in layer order. A layer with no saved session has no entry,
 * so unopened never reads as zero Viewed.
 */
export const PullRequestStatusSchema = Schema.Struct({
  ...pullRequestContextFields,
  selected: PullRequestNumberSchema,
  // #92 adds unresolved-thread counts to these entries.
  sessions: Schema.Array(
    Schema.Struct({
      number: PullRequestNumberSchema,
      sessionId: Schema.String,
      hunkCount: Schema.Natural,
      viewedCount: Schema.Natural,
    }),
  ),
}).check(discoveryOutcome(), stackContainsPullRequest());
export type PullRequestStatus = typeof PullRequestStatusSchema.Type;

/**
 * Status context for a PR session, or undefined for any other. Only saved PR sessions of the same
 * repository count, and only for the selected PR or a layer of its last verified stack: a layer
 * GitHub has since removed stays reachable as a saved session, but not as part of this stack.
 */
export const pullRequestStatusOf = (
  session: Session,
  sessions: Iterable<Session>,
): PullRequestStatus | undefined => {
  const { scope, pullRequest: context } = session;
  if (scope.kind !== "pr" || !context) return undefined;
  const numbers =
    context.stack?.membership === "stacked"
      ? context.stack.layers.map((layer) => layer.pullRequest.number)
      : [scope.number];
  const saved = new Map<number, Session>();
  for (const candidate of sessions)
    if (
      candidate.scope.kind === "pr" &&
      candidate.scope.repository === scope.repository &&
      !saved.has(candidate.scope.number)
    )
      saved.set(candidate.scope.number, candidate);
  return {
    ...context,
    selected: scope.number,
    sessions: numbers.flatMap((number) => {
      const layer = saved.get(number);
      return layer
        ? [
            {
              number,
              sessionId: layer.id,
              hunkCount: layer.hunks.length,
              viewedCount: layer.viewedHunkIds.length,
            },
          ]
        : [];
    }),
  };
};
