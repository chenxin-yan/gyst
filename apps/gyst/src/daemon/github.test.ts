import { describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { PullRequestScope } from "@gyst/core";
import { Effect, Layer } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { GitHub } from "./github.ts";

const scope: PullRequestScope = { kind: "pr", repository: "acme/widgets", number: 2 };
const headRefOid = "b".repeat(40);

type Canned = { readonly exitCode?: number; readonly stdout?: unknown; readonly stderr?: string };
type Call = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: unknown;
};

/** Real GitHub service over a `gh` double: a Node child printing the canned reply, or no `gh`. */
const ask = async <A, E>(effect: Effect.Effect<A, E, GitHub>, canned: Canned | "missing") => {
  const calls: Call[] = [];
  const spawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const live = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") return live.spawn(command);
        calls.push({ command: command.command, args: command.args, env: command.options.env });
        if (canned === "missing")
          return live.spawn(
            ChildProcess.make("/nonexistent/gyst-test/gh", command.args, command.options),
          );
        const stdout =
          typeof canned.stdout === "string" ? canned.stdout : JSON.stringify(canned.stdout ?? "");
        const script = `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(canned.stderr ?? "")}); process.exitCode = ${canned.exitCode ?? 0};`;
        return live.spawn(ChildProcess.make(process.execPath, ["-e", script], command.options));
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  const result = await Effect.runPromise(
    Effect.result(effect).pipe(Effect.provide(GitHub.layer.pipe(Layer.provide(spawner)))),
  );
  return { result, calls };
};
const pullRequest = async (canned: Canned | "missing") => {
  const { result, calls } = await ask(
    GitHub.use((github) => github.pullRequest(scope)),
    canned,
  );
  return { result: result._tag === "Success" ? result.success : result.failure, calls };
};
const stack = async (canned: Canned | "missing") => {
  const { result } = await ask(
    GitHub.use((github) => github.stack(scope)),
    canned,
  );
  return result._tag === "Success" ? result.success : result.failure;
};

const node = (number: number, state = "OPEN") => ({
  number,
  title: `Layer ${number}`,
  body: `Why layer ${number}`,
  state,
  url: `https://github.com/acme/widgets/pull/${number}`,
  baseRefName: number === 1 ? "main" : `layer-${number - 1}`,
  headRefName: `layer-${number}`,
});
const layer = (number: number, state: "open" | "closed" | "merged" = "open") => ({
  number,
  title: `Layer ${number}`,
  description: `Why layer ${number}`,
  state,
  url: `https://github.com/acme/widgets/pull/${number}`,
  baseRefName: number === 1 ? "main" : `layer-${number - 1}`,
  headRefName: `layer-${number}`,
});
const pullReply = (fields: object) => ({ data: { repository: { pullRequest: fields } } });
const stackReply = (
  stackFields: null | {
    size: number;
    totalCount?: number;
    nodes: Array<{ position: number; pullRequest: object | null } | null>;
  },
) =>
  pullReply({
    number: 2,
    stack: stackFields && {
      number: 7,
      size: stackFields.size,
      baseRefName: "main",
      entries: { totalCount: stackFields.totalCount ?? stackFields.size, nodes: stackFields.nodes },
    },
  });
// The shapes recorded from github.com with gh 2.102 (see the #94 report).
const notFound = (path: string[]) => ({
  data: path.length === 1 ? { repository: null } : { repository: { pullRequest: null } },
  errors: [{ type: "NOT_FOUND", path, message: "Could not resolve to a PullRequest" }],
});
const badCredentials = {
  message: "Bad credentials",
  documentation_url: "https://docs.github.com/rest",
  status: "401",
};

describe("GitHub.pullRequest", () => {
  it("reads one PR through gh api graphql on github.com, with explicit argv and no prompts", async () => {
    const { result, calls } = await pullRequest({
      stdout: pullReply({ ...node(2, "MERGED"), headRefOid }),
    });
    expect(result).toEqual({ pullRequest: layer(2, "merged"), headRefOid });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.command).toBe("gh");
    expect(call!.args.slice(0, 10)).toEqual([
      "api",
      "graphql",
      "--hostname",
      "github.com",
      "-f",
      "owner=acme",
      "-f",
      "repo=widgets",
      "-F",
      "number=2",
    ]);
    expect(call!.args.slice(10, 11)).toEqual(["-f"]);
    expect(call!.args).toHaveLength(12);
    expect(call!.args[11]).toMatch(/^query=query\(\$owner:String!.*headRefOid\}\}\}$/s);
    expect(call!.env).toMatchObject({ GH_PROMPT_DISABLED: "1", NO_COLOR: "1" });
  });

  it.each([
    [
      "gh_unauthenticated",
      "exit 4 (no credentials)",
      {
        exitCode: 4,
        stderr: "To get started with GitHub CLI, please run:  gh auth login\n",
      },
    ],
    [
      "gh_unauthenticated",
      "a rejected token (HTTP 401)",
      { exitCode: 1, stdout: badCredentials, stderr: "gh: Bad credentials (HTTP 401)\n" },
    ],
    [
      "no_access",
      "a missing or unreadable PR",
      {
        exitCode: 1,
        stdout: notFound(["repository", "pullRequest"]),
        stderr: "gh: Could not resolve\n",
      },
    ],
    [
      "no_access",
      "a missing or unreadable repository",
      { exitCode: 1, stdout: notFound(["repository"]), stderr: "gh: Could not resolve\n" },
    ],
    [
      "no_access",
      "a forbidden resource",
      {
        exitCode: 1,
        stdout: { data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible" }] },
      },
    ],
    ["github_failed", "a server error", { exitCode: 1, stderr: "gh: HTTP 502: Bad Gateway\n" }],
    [
      "github_failed",
      "a rate limit, which is not a permission answer",
      { exitCode: 1, stderr: "gh: API rate limit exceeded (HTTP 403)\n" },
    ],
    ["github_failed", "unreadable output", { stdout: "not json" }],
    ["github_failed", "another PR's answer", { stdout: pullReply({ ...node(3), headRefOid }) }],
    [
      "github_failed",
      "a partial answer",
      {
        stdout: {
          ...pullReply({ ...node(2), headRefOid }),
          errors: [{ type: "SERVICE_UNAVAILABLE", message: "try later" }],
        },
      },
    ],
  ] as const)("reports %s for %s", async (reason, _case, canned) => {
    const { result } = await pullRequest(canned);
    expect(result).toMatchObject({ _tag: "source_unavailable", detail: { reason } });
  });

  it("reports a missing gh as gh_missing with install guidance", async () => {
    const { result } = await pullRequest("missing");
    expect(result).toMatchObject({
      _tag: "source_unavailable",
      message: expect.stringContaining("install it, run gh auth login"),
      detail: { reason: "gh_missing" },
    });
  });

  it("names the PR and the next step in each message", async () => {
    const { result: denied } = await pullRequest({
      exitCode: 1,
      stdout: notFound(["repository", "pullRequest"]),
    });
    expect(denied).toMatchObject({
      message: expect.stringContaining("https://github.com/acme/widgets/pull/2"),
    });
    const { result: unauthenticated } = await pullRequest({ exitCode: 4 });
    expect(unauthenticated).toMatchObject({ message: expect.stringContaining("gh auth login") });
  });
});

describe("GitHub.stack", () => {
  it("reads an explicit null stack as no membership", async () => {
    expect(await stack({ stdout: stackReply(null) })).toEqual({
      ok: true,
      membership: { membership: "none" },
    });
  });

  it("orders a native stack's layers by GitHub's positions", async () => {
    const result = await stack({
      stdout: stackReply({
        size: 3,
        nodes: [
          { position: 3, pullRequest: node(3) },
          { position: 1, pullRequest: node(1, "MERGED") },
          { position: 2, pullRequest: node(2, "CLOSED") },
        ],
      }),
    });
    expect(result).toEqual({
      ok: true,
      membership: {
        membership: "stacked",
        number: 7,
        baseRefName: "main",
        layers: [
          { position: 1, pullRequest: layer(1, "merged") },
          { position: 2, pullRequest: layer(2, "closed") },
          { position: 3, pullRequest: layer(3) },
        ],
      },
    });
  });

  it.each([
    ["gh_missing", "no gh", "missing"],
    ["gh_unauthenticated", "no credentials", { exitCode: 4 }],
    [
      "no_access",
      "an unreadable PR",
      { exitCode: 1, stdout: notFound(["repository", "pullRequest"]) },
    ],
    [
      "github_failed",
      "a host without stack fields",
      {
        exitCode: 1,
        stdout: {
          errors: [
            {
              path: ["query", "repository", "pullRequest", "stack"],
              extensions: { code: "undefinedField", typeName: "PullRequest", fieldName: "stack" },
              message: "Field 'stack' doesn't exist on type 'PullRequest'",
            },
          ],
        },
        stderr: "gh: Field 'stack' doesn't exist on type 'PullRequest'\n",
      },
    ],
    [
      "github_failed",
      "a stack larger than one page",
      {
        stdout: stackReply({
          size: 101,
          nodes: [
            { position: 1, pullRequest: node(1) },
            { position: 2, pullRequest: node(2) },
          ],
        }),
      },
    ],
    [
      "github_failed",
      "a count that disagrees with the size",
      {
        stdout: stackReply({
          size: 2,
          totalCount: 3,
          nodes: [
            { position: 1, pullRequest: node(1) },
            { position: 2, pullRequest: node(2) },
          ],
        }),
      },
    ],
    [
      "github_failed",
      "an entry whose PR is not readable",
      {
        stdout: stackReply({
          size: 2,
          nodes: [
            { position: 1, pullRequest: null },
            { position: 2, pullRequest: node(2) },
          ],
        }),
      },
    ],
    [
      "github_failed",
      "a null entry",
      { stdout: stackReply({ size: 2, nodes: [null, { position: 2, pullRequest: node(2) }] }) },
    ],
    [
      "github_failed",
      "duplicate positions",
      {
        stdout: stackReply({
          size: 2,
          nodes: [
            { position: 1, pullRequest: node(1) },
            { position: 1, pullRequest: node(2) },
          ],
        }),
      },
    ],
    [
      "github_failed",
      "a stack without the selected PR",
      {
        stdout: stackReply({
          size: 2,
          nodes: [
            { position: 1, pullRequest: node(1) },
            { position: 2, pullRequest: node(3) },
          ],
        }),
      },
    ],
  ] as const)("reports %s, never no membership, for %s", async (reason, _case, canned) => {
    expect(await stack(canned)).toEqual({ ok: false, reason });
  });
});
