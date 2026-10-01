import { parseSnapshot, type Scope, type SnapshotManifest, snapshotIdOf } from "@gyst/core";
import { Effect, Layer, Result, Stream } from "effect";
import { createHash } from "node:crypto";
import { CapturedContent } from "./content.ts";

// Test doubles for the capture seam; imported only by tests.

const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");
const commit = (char: string) => char.repeat(40);

/**
 * What a `Git.capture` double returns: `patch`'s hunks over files whose new side is identified by
 * those hunks, plus unchanged `supporting` files identified by their text.
 */
export const manifestOf = (
  patch: string,
  scope: Scope,
  supporting: Readonly<Record<string, string>> = {},
): SnapshotManifest => {
  const hunks = Result.getOrThrow(parseSnapshot(patch));
  const changed = Map.groupBy(hunks, (hunk) => hunk.file);
  const text = (identity: string) => ({ kind: "text", blob: sha256(identity), size: 1 }) as const;
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
        : {
            kind: "range",
            base: commit("b"),
            head: commit("c"),
            mergeBase: scope.range.includes("...") ? commit("d") : null,
          },
    files,
    hunks,
  };
};

/** Publishes manifests by identity alone; the byte operations are unused through `Sessions`. */
export const publishingContent = (
  putManifest: (typeof CapturedContent)["Service"]["putManifest"] = (manifest) =>
    Effect.succeed(snapshotIdOf(manifest)),
) =>
  Layer.succeed(CapturedContent, {
    putManifest,
    putBlob: () => Effect.die("unused by Sessions"),
    readBlob: () => Stream.die("unused by Sessions"),
    materialize: () => Effect.die("unused by Sessions"),
    loadManifest: () => Effect.die("unused by Sessions"),
  });
