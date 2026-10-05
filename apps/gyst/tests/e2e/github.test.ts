import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  type FakePullRequest,
  fakeGh,
  git,
  githubOrigin,
  githubRepository,
  noGhPath,
  privateRefs,
  refState,
} from "../github.ts";
import { failed, json, sandbox, succeeded } from "./installed-gyst.ts";

type Sandbox = Awaited<ReturnType<typeof sandbox>>;

const url = (number: number) => `https://github.com/${githubRepository}/pull/${number}`;
/** A recorded PR as gyst reports it in a stack layer. */
const layerOf = (recorded: FakePullRequest, index: number) => {
  const { headRefOid: _, body, state, ...pullRequest } = recorded;
  return {
    position: index + 1,
    pullRequest: {
      ...pullRequest,
      description: body,
      state: state.toLowerCase(),
      url: url(pullRequest.number),
    },
  };
};

/**
 * main m1 <- A (#1, layer-a) <- B (#2, layer-b) <- C (#3, layer-c), GitHub's native stack 7, plus
 * #4 (feature) branched from m1 before main moved on to m2 and never restacked. The fake gh is
 * first on the sandbox's PATH before any daemon starts, so the daemon inherits it.
 */
async function stackedRepository(box: Sandbox) {
  const github = await githubOrigin(join(box.root, "github"));
  const fake = await fakeGh(box.root);
  Object.assign(box.env, fake.env(box.env));
  const m1 = git(github.author, "rev-parse", "main");
  const a1 = await github.commit("layer-a", { "a.txt": "layer a\n" }, { from: "main" });
  github.publish("layer-a", 1);
  const b1 = await github.commit("layer-b", { "b.txt": "layer b\n" }, { from: "layer-a" });
  github.publish("layer-b", 2);
  const c1 = await github.commit("layer-c", { "c.txt": "layer c\n" }, { from: "layer-b" });
  github.publish("layer-c", 3);
  const f1 = await github.commit("feature", { "f.txt": "feature\n" }, { from: "main" });
  github.publish("feature", 4);
  const m2 = await github.commit("main", { "README.md": "widgets, moved on\n" });
  github.publish("main");
  const pr = (
    number: number,
    title: string,
    baseRefName: string,
    headRefName: string,
    headRefOid: string,
  ): FakePullRequest => ({
    number,
    title,
    body: `${title}, for review.`,
    state: "OPEN",
    baseRefName,
    headRefName,
    headRefOid,
  });
  const a = pr(1, "Add layer A", "main", "layer-a", a1);
  const b = pr(2, "Add layer B", "layer-a", "layer-b", b1);
  const c = pr(3, "Add layer C", "layer-b", "layer-c", c1);
  const feature = pr(4, "Add the feature", "main", "feature", f1);
  for (const layer of [a, b, c, feature]) await fake.pullRequest(layer);
  const stack = async (...layers: FakePullRequest[]) => {
    for (const layer of layers)
      await fake.stack(layer.number, { number: 7, baseRefName: "main", layers });
  };
  await stack(a, b, c);
  await fake.stack(4, null);
  return { ...github, fake, m1, m2, a, b, c, feature, stack };
}

const manifestOf = async (box: Sandbox, snapshotId: string) =>
  JSON.parse(await readFile(join(box.data, "content", "snapshots", `${snapshotId}.json`), "utf8"));
const savedSessions = async (box: Sandbox) =>
  existsSync(box.data)
    ? (await readdir(box.data)).filter((name) => /^[0-9a-f-]{36}\.json$/.test(name))
    : [];

describe("GitHub PR sessions through the installed CLI", () => {
  it("opens one stack layer at a time, resumes it untouched, refreshes it alone and rechecks metadata", async () => {
    const box = await sandbox();
    const repo = await stackedRepository(box);
    const { checkout, fake } = repo;
    const gyst = (...args: string[]) => box.gyst(checkout, ["session", ...args]);
    const status = async (id: string) => json(await gyst("status", "--session", id));
    const files = async (id: string) =>
      json(await gyst("diff", "--session", id)).hunks.map(({ file }: { file: string }) => file);
    const before = refState(checkout);

    // 1. Open B with only B prepared: the whole stack is context, the diff and work are B's.
    const openedB = json(await gyst("open", url(2)));
    expect(openedB).toMatchObject({
      created: true,
      session: { scope: { kind: "pr", repository: githubRepository, number: 2 } },
    });
    const b = openedB.session.id;
    // One read of B and one stack discovery, both through the fake gh; nothing for A or C.
    const asked = expect.arrayContaining([
      "api",
      "graphql",
      "--hostname",
      "github.com",
      "number=2",
    ]);
    expect(await fake.calls()).toEqual([asked, asked]);
    expect(await files(b)).toEqual(["b.txt"]);
    const hunkId = json(await gyst("diff", "--session", b)).hunks[0].id;
    const prepared = json(
      await box.gyst(
        checkout,
        ["session", "apply", "--session", b],
        JSON.stringify({
          revision: 0,
          snapshotId: openedB.session.snapshotId,
          idempotencyKey: "prepare-b",
          ops: [
            {
              type: "group.create",
              id: "layer-b",
              title: "Layer B",
              overview: "Adds layer B.",
              memberHunkIds: [hunkId],
            },
            {
              type: "note.create",
              id: "on-a",
              group: "layer-b",
              anchor: { path: "b.txt", side: "new", startLine: 1, endLine: 1 },
              markdown: "Read this on top of layer A.",
            },
          ],
        }),
      ),
    );
    const statusB = await status(b);
    expect(statusB.pullRequest).toEqual({
      pullRequest: layerOf(repo.b, 1).pullRequest,
      stack: {
        verifiedAt: expect.any(String),
        membership: "stacked",
        number: 7,
        baseRefName: "main",
        layers: [repo.a, repo.b, repo.c].map(layerOf),
      },
      unavailable: null,
      selected: 2,
      sessions: [{ number: 2, sessionId: b, hunkCount: 1, viewedCount: 0 }],
    });
    // A's file is inherited, unchanged source inside B's own snapshot.
    const snapshotB = openedB.session.snapshotId;
    expect(
      json(
        await gyst(
          "code",
          "--session",
          b,
          "--snapshot",
          snapshotB,
          "--file",
          "a.txt",
          "--side",
          "new",
        ),
      ).content,
    ).toMatchObject({ kind: "text", text: "layer a\n" });
    expect((await manifestOf(box, snapshotB)).provenance).toEqual({
      kind: "pr",
      base: repo.a.headRefOid,
      head: repo.b.headRefOid,
      mergeBase: repo.a.headRefOid,
    });
    expect(refState(checkout)).toEqual(before);
    expect(privateRefs(checkout)).toEqual([
      `refs/gyst/github/acme/widgets/pull/2/base ${repo.a.headRefOid}`,
      `refs/gyst/github/acme/widgets/pull/2/head ${repo.b.headRefOid}`,
    ]);

    // 2. Open C plain: its own range, no guidance carried over.
    const openedC = json(await gyst("open", url(3)));
    expect(openedC.created).toBe(true);
    const c = openedC.session.id;
    expect(await files(c)).toEqual(["c.txt"]);
    expect((await status(c)).groups).toEqual([]);
    expect((await status(b)).pullRequest.sessions).toEqual([
      { number: 2, sessionId: b, hunkCount: 1, viewedCount: 0 },
      { number: 3, sessionId: c, hunkCount: 1, viewedCount: 0 },
    ]);

    // 3. Return to B: the saved session as it was, with no refresh and no GitHub call.
    const calls = (await fake.calls()).length;
    const resumed = json(await gyst("open", url(2)));
    expect(resumed).toEqual({ ...openedB, session: prepared.session, created: false });
    expect(resumed.session.snapshotId).toBe(snapshotB);
    expect(await status(b)).toMatchObject({
      revision: 1,
      groups: [{ id: "layer-b", notes: [{ markdown: "Read this on top of layer A." }] }],
    });
    expect((await fake.calls()).length).toBe(calls);

    // 4. Restack in origin, then explicitly refresh B: B's new merge base; C and A untouched.
    const statusC = await status(c);
    const a2 = await repo.commit("layer-a", { "a.txt": "layer a, revised\n" });
    git(repo.author, "rebase", "-q", "--onto", "layer-a", repo.a.headRefOid, "layer-b");
    git(repo.author, "rebase", "-q", "--onto", "layer-b", repo.b.headRefOid, "layer-c");
    const restacked = {
      a: { ...repo.a, headRefOid: repo.publish("layer-a", 1) },
      b: { ...repo.b, headRefOid: repo.publish("layer-b", 2) },
      c: { ...repo.c, headRefOid: repo.publish("layer-c", 3) },
    };
    expect(restacked.a.headRefOid).toBe(a2);
    for (const layer of Object.values(restacked)) await fake.pullRequest(layer);
    const refreshed = json(await gyst("refresh", "--session", b));
    expect(refreshed.session.snapshotId).not.toBe(snapshotB);
    expect((await manifestOf(box, refreshed.session.snapshotId)).provenance).toEqual({
      kind: "pr",
      base: a2,
      head: restacked.b.headRefOid,
      mergeBase: a2,
    });
    expect(await status(c)).toEqual(statusC);
    const sessions = json(await gyst("list")).sessions;
    expect(sessions.map(({ scope }: { scope: { number: number } }) => scope.number)).toEqual([
      2, 3,
    ]);
    expect(refState(checkout)).toEqual(before);

    // 5. A verified recheck drops C from the stack, yet C's session stays reachable.
    await repo.stack(restacked.a, restacked.b);
    const afterRefresh = await status(b);
    const verified = json(await gyst("check", "--session", b, "--stack"));
    expect(verified).toEqual({
      sessionId: b,
      pullRequest: {
        ...afterRefresh.pullRequest,
        stack: {
          ...afterRefresh.pullRequest.stack,
          verifiedAt: expect.any(String),
          layers: [restacked.a, restacked.b].map(layerOf),
        },
        sessions: [{ number: 2, sessionId: b, hunkCount: 1, viewedCount: 0 }],
      },
    });
    // Metadata only: B's snapshot, revision and guidance are as the refresh left them.
    expect({ ...(await status(b)), pullRequest: undefined }).toEqual({
      ...afterRefresh,
      pullRequest: undefined,
    });
    expect(json(await gyst("list")).sessions.map(({ id }: { id: string }) => id)).toContain(c);
    expect(await files(c)).toEqual(["c.txt"]);
    expect((await status(c)).session.snapshotId).toBe(openedC.session.snapshotId);

    // A failed recheck is unavailable, never a verified removal, and keeps the last verified stack.
    await fake.fail("stack", 2, {
      exitCode: 1,
      stdout: '{"message":"Server Error","status":"502"}',
      stderr: "gh: Server Error (HTTP 502)\n",
    });
    const failedRecheck = json(await gyst("check", "--session", b, "--stack"));
    expect(failedRecheck.pullRequest).toEqual({
      ...verified.pullRequest,
      unavailable: { at: expect.any(String), reason: "github_failed" },
    });
    expect(failedRecheck.pullRequest.stack.verifiedAt).toBe(verified.pullRequest.stack.verifiedAt);
    expect(refState(checkout)).toEqual(before);
  }, 60_000);

  it("reviews a non-restacked PR from its true merge base, and opens it while discovery is unavailable", async () => {
    const box = await sandbox();
    const repo = await stackedRepository(box);
    const gyst = (...args: string[]) => box.gyst(repo.checkout, ["session", ...args]);

    // 6. #4's range starts where it branched (m1), so main's later change (m2) is not in it.
    const opened = json(await gyst("open", url(4)));
    const id = opened.session.id;
    expect(await savedSessions(box)).toEqual([`${id}.json`]);
    expect((await manifestOf(box, opened.session.snapshotId)).provenance).toEqual({
      kind: "pr",
      base: repo.m2,
      head: repo.feature.headRefOid,
      mergeBase: repo.m1,
    });
    expect(
      json(await gyst("diff", "--session", id)).hunks.map(({ file }: { file: string }) => file),
    ).toEqual(["f.txt"]);
    expect(json(await gyst("status", "--session", id)).pullRequest).toMatchObject({
      stack: { verifiedAt: expect.any(String), membership: "none" },
      unavailable: null,
      selected: 4,
    });

    // 9. Discovery fails but the range resolves: standalone review opens, membership unknown.
    succeeded(await gyst("delete", "--session", id, "--request-id", "reopen"));
    await repo.fake.fail("stack", 4, {
      exitCode: 1,
      stdout: '{"errors":[{"message":"Field \'stack\' doesn\'t exist on type \'PullRequest\'"}]}',
      stderr: "gh: Field 'stack' doesn't exist on type 'PullRequest'\n",
    });
    const reopened = json(await gyst("open", url(4)));
    expect(reopened.created).toBe(true);
    expect(reopened.session.snapshotId).toBe(opened.session.snapshotId);
    expect(json(await gyst("status", "--session", reopened.session.id)).pullRequest).toMatchObject({
      stack: null,
      unavailable: { at: expect.any(String), reason: "github_failed" },
      selected: 4,
      sessions: [{ number: 4, sessionId: reopened.session.id }],
    });
  }, 60_000);

  it("refuses each unopenable PR with its own actionable error and saves nothing", async () => {
    const box = await sandbox();
    const repo = await stackedRepository(box);
    const { checkout, fake } = repo;
    const before = refState(checkout);
    const refused = async (cwd: string, number: number) => {
      const error = failed(await box.gyst(cwd, ["session", "open", url(number)]));
      expect(await savedSessions(box)).toEqual([]);
      return error;
    };

    await fake.fail("pull", 1, {
      exitCode: 4,
      stderr: "To get started with GitHub CLI, please run:  gh auth login\n",
    });
    expect(await refused(checkout, 1)).toMatchObject({
      code: "source_unavailable",
      message: expect.stringContaining("gh auth login"),
      detail: { reason: "gh_unauthenticated" },
    });

    await fake.fail("pull", 2, {
      exitCode: 1,
      stdout: JSON.stringify({
        data: { repository: { pullRequest: null } },
        errors: [
          {
            type: "NOT_FOUND",
            path: ["repository", "pullRequest"],
            message: "Could not resolve to a PullRequest with the number of 2.",
          },
        ],
      }),
      stderr: "gh: Could not resolve to a PullRequest with the number of 2.\n",
    });
    expect(await refused(checkout, 2)).toMatchObject({
      code: "source_unavailable",
      message: `${url(2)} was not found or is not readable by the gyst host's gh account`,
      detail: { reason: "no_access" },
    });

    // GitHub knows #5, but origin serves no refs/pull/5/head.
    await fake.pullRequest({ ...repo.feature, number: 5, headRefName: "gone" });
    expect(await refused(checkout, 5)).toMatchObject({
      code: "source_unavailable",
      message: expect.stringContaining(`could not fetch ${url(5)}`),
      detail: { reason: "objects_missing" },
    });

    // A checkout of some other repository has no remote for acme/widgets.
    const elsewhere = join(box.root, "elsewhere");
    git(box.root, "init", "-q", "-b", "main", elsewhere);
    git(elsewhere, "remote", "add", "origin", "https://github.com/acme/gadgets.git");
    expect(await refused(elsewhere, 3)).toMatchObject({
      code: "source_unavailable",
      message: expect.stringContaining("github.com/acme/widgets"),
      detail: { reason: "checkout_mismatch" },
    });
    expect(refState(checkout)).toEqual(before);
  }, 60_000);

  it("reports gh_missing without gh on the host, where local and range review still work", async () => {
    const box = await sandbox();
    const github = await githubOrigin(join(box.root, "github"));
    box.env.PATH = await noGhPath(box.root);
    const { checkout } = github;

    expect(failed(await box.gyst(checkout, ["session", "open", url(2)]))).toMatchObject({
      code: "source_unavailable",
      message: expect.stringContaining("install it, run gh auth login"),
      detail: { reason: "gh_missing" },
    });
    expect(await savedSessions(box)).toEqual([]);

    git(checkout, "switch", "-q", "-c", "local");
    await writeFile(join(checkout, "local.txt"), "committed locally\n");
    git(checkout, "add", "local.txt");
    git(checkout, "commit", "-qm", "local change");
    await writeFile(join(checkout, "README.md"), "edited, uncommitted\n");
    const range = json(await box.gyst(checkout, ["session", "open", "main...local"]));
    const uncommitted = json(await box.gyst(checkout, ["session", "open"]));
    expect([range.created, uncommitted.created]).toEqual([true, true]);
  }, 60_000);

  it("opens local and range sessions without ever calling gh", async () => {
    const box = await sandbox();
    const repo = await stackedRepository(box);
    const { checkout } = repo;
    await writeFile(join(checkout, "README.md"), "edited, uncommitted\n");

    // 8. The fake gh is first on PATH, yet nothing reaches it.
    const uncommitted = json(await box.gyst(checkout, ["session", "open"]));
    const range = json(await box.gyst(checkout, ["session", "open", "HEAD...origin/main"]));
    expect(uncommitted.session.scope).toEqual({ kind: "uncommitted" });
    expect(range.session.scope).toEqual({ kind: "range", range: "HEAD...origin/main" });
    expect(await repo.fake.calls()).toEqual([]);
    expect(existsSync(join(repo.fake.dir, "calls.jsonl"))).toBe(false);
  }, 60_000);
});
