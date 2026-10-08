import {
  BadArgs,
  type Commit,
  parseSnapshot,
  type Scope,
  type SnapshotManifest,
  snapshotIdOf,
} from "@gyst/core";
import { Effect, Layer, Result, Stream } from "effect";
import { createHash } from "node:crypto";
import { CapturedContent } from "./content.ts";
import { GitHub } from "./github.ts";

// Test doubles for the capture seam; imported only by tests.

const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");
/** What each blob the capture double names holds: the text that identifies it. */
const blobTexts = new Map<string, string>();
const commit = (char: string) => char.repeat(40);

/**
 * What a `Git.capture` double returns: `patch`'s hunks over files whose new side is identified by
 * those hunks, plus unchanged `supporting` files identified by their text, and for a range its
 * `commits`.
 */
export const manifestOf = (
  patch: string,
  scope: Scope,
  supporting: Readonly<Record<string, string>> = {},
  commits: readonly Commit[] = [],
): SnapshotManifest => {
  const hunks = Result.getOrThrow(parseSnapshot(patch));
  const changed = Map.groupBy(hunks, (hunk) => hunk.file);
  const text = (identity: string) => {
    const blob = sha256(identity);
    blobTexts.set(blob, identity);
    return { kind: "text", blob, size: 1 } as const;
  };
  const files = [
    ...[...changed].map(([path, fileHunks]) => ({
      path,
      old: text(`old\0${path}`),
      new: text(fileHunks.map((hunk) => hunk.patch).join("\0")),
    })),
    ...Object.entries(supporting).map(([path, content]) => {
      const side = text(content);
      return { path, old: side, new: side };
    }),
  ].sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    scope,
    provenance:
      scope.kind === "uncommitted"
        ? { kind: "uncommitted", head: commit("a") }
        : scope.kind === "pr"
          ? { kind: "pr", base: commit("b"), head: commit("c"), mergeBase: commit("d") }
          : {
              kind: "range",
              base: commit("b"),
              head: commit("c"),
              mergeBase: scope.range.includes("...") ? commit("d") : null,
            },
    files,
    hunks,
    ...(scope.kind === "range" && { commits }),
  };
};

/** For tests whose sessions are all local: any GitHub call is a defect. */
export const noGitHub = Layer.succeed(GitHub, {
  pullRequest: () => Effect.die("no GitHub calls in this test"),
  stack: () => Effect.die("no GitHub calls in this test"),
});

/**
 * Publishes manifests by identity alone and loads back those it published. A blob `manifestOf`
 * named reads back whole as its identifying text (a supporting file's content); other byte
 * operations are unused through `Sessions`.
 */
export const publishingContent = (
  putManifest: (typeof CapturedContent)["Service"]["putManifest"] = (manifest) =>
    Effect.succeed(snapshotIdOf(manifest)),
) => {
  const published = new Map<string, SnapshotManifest>();
  return Layer.succeed(CapturedContent, {
    putManifest: (manifest) =>
      putManifest(manifest).pipe(
        Effect.tap((snapshotId) => Effect.sync(() => published.set(snapshotId, manifest))),
      ),
    putBlob: () => Effect.die("unused by Sessions"),
    readBlob: (blob) => {
      const text = blobTexts.get(blob);
      return text === undefined
        ? Stream.die("unused by Sessions")
        : Stream.succeed(new TextEncoder().encode(text));
    },
    materialize: () => Effect.die("unused by Sessions"),
    loadManifest: (snapshotId) => {
      const manifest = published.get(snapshotId);
      return manifest
        ? Effect.succeed(manifest)
        : Effect.fail(new BadArgs({ message: "snapshot not found", detail: snapshotId }));
    },
  });
};
