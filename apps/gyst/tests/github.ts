// A GitHub repository without the network: a bare `origin` serving branches and `refs/pull/<n>/head`,
// an authoring clone that publishes to it, and the checkout under test. The checkout's origin is the
// real-looking https://github.com/acme/widgets.git, redirected to the bare repo by a repo-local
// insteadOf, so remote matching sees the URL a real clone has.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const githubUrl = "https://github.com/acme/widgets.git";
export const githubRepository = "acme/widgets";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const identity = (cwd: string) => {
  git(cwd, "config", "user.email", "test@gyst.invalid");
  git(cwd, "config", "user.name", "Gyst Test");
};

export type GitHubOrigin = {
  readonly origin: string;
  readonly author: string;
  readonly checkout: string;
  /** Commits `files` on `branch` in the authoring clone, creating it from `from` if new. */
  commit(
    branch: string,
    files: Record<string, string>,
    options?: { readonly from?: string },
  ): Promise<string>;
  /** Force-pushes `branch` to origin, and as `refs/pull/<pr>/head` when `pr` is given. */
  publish(branch: string, pr?: number): string;
};

export async function githubOrigin(root: string): Promise<GitHubOrigin> {
  const origin = join(root, "origin.git");
  const author = join(root, "author");
  const checkout = join(root, "checkout");
  await mkdir(origin, { recursive: true });
  git(origin, "init", "-q", "--bare", "-b", "main");
  await mkdir(author, { recursive: true });
  git(author, "init", "-q", "-b", "main");
  identity(author);
  git(author, "remote", "add", "origin", origin);

  const commit: GitHubOrigin["commit"] = async (branch, files, options = {}) => {
    if (git(author, "symbolic-ref", "--short", "HEAD") !== branch)
      git(
        author,
        "switch",
        "-q",
        ...(git(author, "branch", "--list", branch) === ""
          ? ["-c", branch, options.from ?? "HEAD"]
          : [branch]),
      );
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(author, path)), { recursive: true });
      await writeFile(join(author, path), text);
    }
    git(author, "add", "-A");
    git(author, "commit", "-qm", `${branch}: ${Object.keys(files).join(", ")}`);
    return git(author, "rev-parse", "HEAD");
  };
  const publish: GitHubOrigin["publish"] = (branch, pr) => {
    git(
      author,
      "push",
      "-q",
      "--force",
      "origin",
      `${branch}:refs/heads/${branch}`,
      ...(pr === undefined ? [] : [`${branch}:refs/pull/${pr}/head`]),
    );
    return git(author, "rev-parse", branch);
  };

  await commit("main", { "README.md": "widgets\n" });
  publish("main");
  git(root, "clone", "-q", origin, checkout);
  identity(checkout);
  git(checkout, "remote", "set-url", "origin", githubUrl);
  git(checkout, "config", `url.${origin}.insteadOf`, githubUrl);
  return { origin, author, checkout, commit, publish };
}

/** Everything a PR fetch must leave alone: HEAD, branches, remote-tracking refs, tags, index, worktree. */
export const refState = (checkout: string) => {
  const fetchHead = join(checkout, ".git", "FETCH_HEAD");
  return {
    head: git(checkout, "rev-parse", "HEAD"),
    symbolicRef: git(checkout, "symbolic-ref", "-q", "HEAD"),
    index: git(checkout, "ls-files", "-s"),
    status: git(checkout, "status", "--porcelain=v2", "--untracked-files=all"),
    refs: git(checkout, "for-each-ref", "--format=%(refname) %(objectname)")
      .split("\n")
      .filter((line) => !line.startsWith("refs/gyst/")),
    fetchHead: existsSync(fetchHead) ? readFileSync(fetchHead, "utf8") : null,
  };
};

/** The private refs gyst created, as `ref oid` lines. */
export const privateRefs = (checkout: string) =>
  git(checkout, "for-each-ref", "--format=%(refname) %(objectname)", "refs/gyst/")
    .split("\n")
    .filter(Boolean);
