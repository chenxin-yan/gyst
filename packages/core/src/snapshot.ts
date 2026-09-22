import { parsePatchFiles } from "@pierre/diffs";
import { Result } from "effect";
import { BadArgs } from "./errors.ts";
import type { Hunk } from "./session.ts";

const invalidDiff = (detail: string) =>
  Result.fail(new BadArgs({ message: "invalid unified diff", detail }));

export function parseSnapshot(patch: string): Result.Result<Hunk[], BadArgs> {
  return Result.flatMap(
    Result.try({
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
  const hunks: Hunk[] = [];
  const ids = new Set<string>();
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
      const digest = Bun.hash(`${file.name}\0${text}`).toString(16).padStart(16, "0");
      // Ids are the agent's handles; a collision must not make two hunks one.
      let id = digest;
      for (let n = 2; ids.has(id); n++) id = `${digest}-${n}`;
      ids.add(id);
      hunks.push({
        id,
        file: file.name,
        header: (parsedHunk.hunkSpecs ?? "").trimEnd(),
        patch: text,
      });
    }
  }
  return Result.succeed(hunks);
}
