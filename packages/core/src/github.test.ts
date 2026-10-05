import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import {
  parsePullRequestUrl,
  type PullRequest,
  PullRequestContextSchema,
  pullRequestUrlOf,
  RepositorySchema,
  StackMembershipSchema,
} from "./github.ts";
import { type Session, SessionSchema } from "./session.ts";

const strict = { onExcessProperty: "error" } as const;
const decodeMembership = Schema.decodeUnknownSync(StackMembershipSchema, strict);
const decodeContext = Schema.decodeUnknownSync(PullRequestContextSchema, strict);

const pullRequest = (number: number): PullRequest => ({
  number,
  title: `Layer ${number}`,
  description: "",
  state: "open",
  url: `https://github.com/acme/widgets/pull/${number}`,
  baseRefName: number === 1 ? "main" : `layer-${number - 1}`,
  headRefName: `layer-${number}`,
});
const stacked = (...numbers: number[]) => ({
  membership: "stacked",
  number: 7,
  baseRefName: "main",
  layers: numbers.map((number, index) => ({
    position: index + 1,
    pullRequest: pullRequest(number),
  })),
});

describe("parsePullRequestUrl", () => {
  it("accepts github.com PR URLs, with any trailing path, query or fragment, as a lowercased scope", () => {
    for (const url of [
      "https://github.com/acme/widgets/pull/12",
      "https://github.com/acme/widgets/pull/12/",
      "https://github.com/acme/widgets/pull/12/files",
      "https://github.com/acme/widgets/pull/12?diff=split",
      "https://github.com/acme/widgets/pull/12#discussion_r1",
      "https://github.com/Acme/Widgets/pull/12",
    ])
      expect(parsePullRequestUrl(url), url).toEqual({
        kind: "pr",
        repository: "acme/widgets",
        number: 12,
      });
    expect(parsePullRequestUrl("https://github.com/my-org/repo.name_2/pull/3")).toEqual({
      kind: "pr",
      repository: "my-org/repo.name_2",
      number: 3,
    });
  });

  it("rejects every other URL or text", () => {
    for (const text of [
      "http://github.com/acme/widgets/pull/12",
      "https://www.github.com/acme/widgets/pull/12",
      "https://github.com.evil.example/acme/widgets/pull/12",
      "https://gitlab.com/acme/widgets/pull/12",
      "https://user@github.com/acme/widgets/pull/12",
      "https://github.com:443/acme/widgets/pull/12",
      "https://github.com/acme/widgets/issues/12",
      "https://github.com/acme/widgets/pulls/12",
      "https://github.com/acme/widgets/pull/0",
      "https://github.com/acme/widgets/pull/012",
      "https://github.com/acme/widgets/pull/12x",
      "https://github.com/acme/widgets/pull/99999999999999999999",
      "https://github.com/acme/widgets/pull/",
      "https://github.com/acme/../pull/12",
      "https://github.com/acme/a..b/pull/12",
      "https://github.com/acme/.hidden/pull/12",
      "https://github.com/acme/x.lock/pull/12",
      "https://github.com/a%2fb/widgets/pull/12",
      "https://github.com/extra/acme/widgets/pull/12",
      "https://github.com/acme/widgets/pull/12\nsecond line",
      " https://github.com/acme/widgets/pull/12",
      "main...feature",
    ])
      expect(parsePullRequestUrl(text), text).toBeUndefined();
  });

  it("round-trips through pullRequestUrlOf", () => {
    const scope = { kind: "pr", repository: "acme/widgets", number: 12 } as const;
    expect(parsePullRequestUrl(pullRequestUrlOf(scope))).toEqual(scope);
  });
});

describe("RepositorySchema", () => {
  it("holds one lowercase spelling per repository", () => {
    expect(Schema.is(RepositorySchema)("acme/widgets")).toBe(true);
    for (const repository of ["Acme/widgets", "acme", "acme/widgets/x", "/widgets", "acme/"])
      expect(Schema.is(RepositorySchema)(repository), repository).toBe(false);
  });
});

describe("StackMembershipSchema", () => {
  it("is explicit none or a stack's layers in position order 1..n", () => {
    expect(decodeMembership({ membership: "none" })).toEqual({ membership: "none" });
    expect(decodeMembership(stacked(1, 2, 3))).toEqual(stacked(1, 2, 3));
    const unsorted = stacked(1, 2, 3);
    unsorted.layers.reverse();
    const gap = stacked(1, 2);
    gap.layers[1]!.position = 3;
    for (const invalid of [unsorted, gap, stacked(), stacked(1, 1)])
      expect(() => decodeMembership(invalid)).toThrow();
  });
});

describe("PullRequestContextSchema", () => {
  const at = "2026-01-01T00:00:00.000Z";
  it("keeps the last verified stack beside a later failure", () => {
    for (const context of [
      {
        pullRequest: pullRequest(2),
        stack: { verifiedAt: at, ...stacked(1, 2) },
        unavailable: null,
      },
      {
        pullRequest: pullRequest(2),
        stack: { verifiedAt: at, membership: "none" },
        unavailable: null,
      },
      { pullRequest: pullRequest(2), stack: null, unavailable: { at, reason: "github_failed" } },
      {
        pullRequest: pullRequest(2),
        stack: { verifiedAt: at, ...stacked(1, 2) },
        unavailable: { at, reason: "gh_unauthenticated" },
      },
    ])
      expect(decodeContext(context)).toEqual(context);
  });

  it("rejects a context without any discovery outcome or with a stack missing its PR", () => {
    expect(() =>
      decodeContext({ pullRequest: pullRequest(2), stack: null, unavailable: null }),
    ).toThrow("neither a result nor a failure");
    expect(() =>
      decodeContext({
        pullRequest: pullRequest(2),
        stack: { verifiedAt: at, ...stacked(1, 3) },
        unavailable: null,
      }),
    ).toThrow("must contain its PR");
    expect(() =>
      decodeContext({
        pullRequest: pullRequest(2),
        stack: null,
        unavailable: { at, reason: "objects_missing" },
      }),
    ).toThrow();
  });
});

describe("SessionSchema PR context", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const base: Session = {
    id: "s",
    repoRoot: "/repo",
    scope: { kind: "uncommitted" },
    snapshotId: "a".repeat(64),
    createdAt: at,
    updatedAt: at,
    revision: 0,
    hunks: [],
    groups: [],
    viewedHunkIds: [],
    receiptNoteTexts: [],
    applyReceipts: [],
    viewedReceipts: [],
  };
  const context = {
    pullRequest: pullRequest(2),
    stack: { verifiedAt: at, membership: "none" },
    unavailable: null,
  } as const;
  const decodeSession = Schema.decodeUnknownSync(SessionSchema, strict);
  const scope = { kind: "pr", repository: "acme/widgets", number: 2 } as const;

  it("carries GitHub context exactly when the scope is a PR", () => {
    const pr = { ...base, scope, pullRequest: context };
    expect(decodeSession(pr)).toEqual(pr);
    expect(decodeSession(base)).toEqual(base);
    expect(() => decodeSession({ ...base, scope })).toThrow("GitHub PR context exactly");
    for (const local of [base.scope, { kind: "range", range: "main...feature" }])
      expect(() => decodeSession({ ...base, scope: local, pullRequest: context })).toThrow(
        "GitHub PR context exactly",
      );
  });
});
