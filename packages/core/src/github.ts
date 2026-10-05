import { Schema } from "effect";

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

/**
 * A PR session's GitHub context, kept apart from its snapshot. `stack` is the last successful
 * discovery and when it happened; `unavailable` is the latest attempt when it failed. A failure
 * never replaces `stack`, so unknown membership cannot read as verified removal or as fresh.
 */
export const PullRequestContextSchema = Schema.Struct({
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
}).check(
  Schema.makeFilter(
    ({ stack, unavailable }) =>
      stack !== null ||
      unavailable !== null ||
      "stack discovery has neither a result nor a failure",
  ),
  Schema.makeFilter(
    ({ pullRequest, stack }) =>
      stack?.membership !== "stacked" ||
      stack.layers.some((layer) => layer.pullRequest.number === pullRequest.number) ||
      "a discovered stack must contain its PR",
  ),
);
export type PullRequestContext = typeof PullRequestContextSchema.Type;
