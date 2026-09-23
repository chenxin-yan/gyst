import { parsePatchFiles } from "@pierre/diffs";
import { Result } from "effect";
import { BadArgs } from "./errors.ts";
import { hash } from "./hash.ts";
import type { Hunk } from "./session.ts";

const invalidDiff = (detail: string) =>
  Result.fail(new BadArgs({ message: "invalid unified diff", detail }));

export function parseSnapshot(patch: string): Result.Result<Hunk[], BadArgs> {
  return Result.flatMap(
    Result.try({
      // TODO: Upgrade once https://github.com/pierrecomputer/pierre/pull/1143 ships.
      // Git-quoted filenames currently stay escaped, so editor targets may not resolve.
      try: () => parsePatchFiles(patch, undefined, true).flatMap((parsed) => parsed.files),
      catch: (error) =>
        new BadArgs({
          message: "invalid unified diff",
          detail: error instanceof Error ? error.message : String(error),
        }),
    }),
    (files) => hunksOf(patch, files),
  );
}

function hunksOf(
  patch: string,
  files: ReturnType<typeof parsePatchFiles>[number]["files"],
): Result.Result<Hunk[], BadArgs> {
  if (files.length === 0 && /\S/.test(patch)) return invalidDiff("input is not a unified diff");
  const unsupported = files.find((file) => file.hunks.length === 0);
  if (unsupported)
    return invalidDiff(`file-level change without text hunks is unsupported: ${unsupported.name}`);
  const rawHunks = [
    ...patch.matchAll(/^@@[^\n]*(?:\n|$)[\s\S]*?(?=^@@|^diff --git |(?![\s\S]))/gm),
  ].map((match) => match[0].replace(/\n$/, ""));
  const parsedHunkCount = files.reduce((count, file) => count + file.hunks.length, 0);
  if (rawHunks.length !== parsedHunkCount)
    return invalidDiff("parsed hunk count does not match unified diff");
  let index = 0;
  const occurrences = new Map<string, number>();
  const hunks: Hunk[] = [];
  for (const file of files) {
    for (const parsedHunk of file.hunks) {
      const lines = rawHunks[index++]!.split("\n");
      let remainingOld = parsedHunk.deletionCount;
      let remainingNew = parsedHunk.additionCount;
      let end = 1;
      // File headers can look like hunk content; only the declared counts end a hunk.
      while (end < lines.length) {
        const sign = lines[end]![0];
        if (remainingOld === 0 && remainingNew === 0 && sign !== "\\") break;
        if (sign === "-" || sign === " ") remainingOld--;
        if (sign === "+" || sign === " ") remainingNew--;
        end++;
      }
      const text = lines.slice(0, end).join("\n");
      // The body hash matches a hunk across refreshes even when its line numbers moved; the
      // occurrence index keeps identical hunks distinct so ids stay stable and unique.
      const identity = `${file.name}\0${text}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      hunks.push({
        id: hash(`${identity}\0${occurrence}`),
        file: file.name,
        header: (parsedHunk.hunkSpecs ?? "").trimEnd(),
        patch: text,
        contentHash: hash(text.slice(text.indexOf("\n") + 1)),
      });
    }
  }
  return Result.succeed(hunks);
}
