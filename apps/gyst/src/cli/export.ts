// `gyst session export`'s human side: the disclosure a person reads at the terminal, their
// approval, and writing the file whole or not at all.
import {
  BadArgs,
  type ExportPreviewPayload,
  type PinnedSide,
  provenanceLines,
  SourceUnavailable,
} from "@gyst/core";
import { Effect, FileSystem, type PlatformError } from "effect";
import { createInterface } from "node:readline/promises";
import { dirname } from "node:path";

const identity = ({ content }: PinnedSide) =>
  content.kind === "text"
    ? `sha256 ${content.blob} (${content.size} bytes)`
    : content.kind === "absent"
      ? "absent"
      : `not captured: ${content.reason}`;

// eslint-disable-next-line no-control-regex -- exactly the controls to show escaped
const terminalControls = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;
/**
 * `text` with every character a terminal could act on (C0 and C1 controls, DEL, line separators
 * and directional marks) written as a `\u` escape. A captured path may hold any of them, and one
 * left raw could erase, overwrite or reorder the lines a person approves.
 */
const visible = (text: string) =>
  text.replace(
    terminalControls,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** What the export of `preview` writes to `path`, and the warning, as the terminal shows it. */
export function disclosureOf(preview: ExportPreviewPayload, path: string): string {
  const lines = [
    `gyst would write a standalone walkthrough to ${path}`,
    ...provenanceLines(preview.scope, preview.provenance).map((line) => `  ${line}`),
    `  Snapshot: ${preview.snapshotId}`,
    "",
    `Included in full (${preview.included.length} file sides):`,
    ...preview.included.map(
      (side) =>
        `  ${side.path} (${side.side}${side.snapshotId === preview.snapshotId ? "" : `, earlier snapshot ${side.snapshotId}`}): ${identity(side)}`,
    ),
  ];
  if (preview.unavailable.length > 0)
    lines.push(
      "",
      "Unavailable references, shown in the file with their reason:",
      ...preview.unavailable.map(
        ({ target, reason }) =>
          `  ${target.path}:${target.startLine}-${target.endLine} (${target.side}, snapshot ${target.snapshotId}): ${reason}`,
      ),
    );
  lines.push(
    "",
    "WARNING: the file contains every file above in full and all of the walkthrough's guidance.",
    "Full files and guidance may disclose secrets or confidential content. Check them before you",
    "share the file; gyst does not scan or redact anything.",
    "",
  );
  return lines.map(visible).join("\n");
}

/** Asks the person at this terminal; only an explicit `yes` approves. */
export const approvedAtTerminal = (question: string) =>
  Effect.acquireUseRelease(
    Effect.sync(() => createInterface({ input: process.stdin, output: process.stderr })),
    (terminal) =>
      Effect.promise(() =>
        terminal.question(question).then(
          (answer) => answer.trim().toLowerCase() === "yes",
          () => false,
        ),
      ),
    (terminal) => Effect.sync(() => terminal.close()),
  );

const codeOf = (error: PlatformError.PlatformError) => {
  const cause = error.reason.cause;
  return typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
};

/** The failure of a write that left nothing at `path`. */
const unwritten = (path: string) => (error: PlatformError.PlatformError) =>
  error.reason._tag === "AlreadyExists"
    ? new BadArgs({
        message: `${path} already exists; choose another --output. Nothing was written.`,
      })
    : codeOf(error) === "ENOSPC" || codeOf(error) === "EDQUOT"
      ? new SourceUnavailable({
          message: `no space left to write ${path}. Nothing was written.`,
          detail: { reason: "storage_full" },
        })
      : new BadArgs({
          message: `could not write ${path}. Nothing was written.`,
          detail: error.message,
        });

/**
 * Writes `text` to `path`, which must not exist yet: synced in a temporary file beside it, then
 * hard-linked into place, so the path never holds part of the file and an existing file, even one
 * created meanwhile, is never replaced. A failure leaves no file at `path`; if the file is in place
 * but its directory cannot be synced and the file cannot be removed again, the failure says so.
 */
export const writeNewFile = (path: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.gen(function* () {
      const temporary = yield* fs.makeTempFileScoped({ directory: dirname(path) });
      yield* fs.writeFileString(temporary, text);
      yield* Effect.scoped(Effect.flatMap(fs.open(temporary, { flag: "r" }), (file) => file.sync));
      yield* fs.link(temporary, path);
    }).pipe(Effect.scoped, Effect.mapError(unwritten(path)));
    yield* Effect.scoped(
      Effect.flatMap(fs.open(dirname(path), { flag: "r" }), (directory) => directory.sync),
    ).pipe(
      Effect.catch((error) =>
        fs.remove(path).pipe(
          Effect.matchEffect({
            onSuccess: () => Effect.fail(unwritten(path)(error)),
            onFailure: () =>
              Effect.fail(
                new BadArgs({
                  message: `${path} holds the whole walkthrough, but gyst could not confirm it is saved or remove it; check it before sharing it, or delete it.`,
                  detail: error.message,
                }),
              ),
          }),
        ),
      ),
    );
  }).pipe(Effect.withSpan("writeNewFile"));
