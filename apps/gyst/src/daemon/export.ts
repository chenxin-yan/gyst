import {
  type ExportPayload,
  InternalError,
  type Walkthrough,
  type WalkthroughExport,
  WalkthroughExportSchema,
} from "@gyst/core";
import { walkthroughPlaceholder } from "@gyst/core/web";
import { Context, DateTime, Effect, Schema } from "effect";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { daemonVersion } from "./protocol.ts";

/** The packaged standalone reader (`dist/export`) beside the bundled `bin/gyst.js`. */
export const installedExportTemplate = fileURLToPath(
  new URL("../dist/export/index.html", import.meta.url),
);

/** The standalone reader an export is built from: the packaged one, unless a test supplies its own. */
export const ExportTemplate = Context.Reference<string>("gyst/daemon/ExportTemplate", {
  defaultValue: () => installedExportTemplate,
});

const encodeExport = Schema.encodeSync(WalkthroughExportSchema);

/**
 * The template with `data` in its slot. Every `<`, `>` and `&` in the JSON (only ever inside its
 * strings) is written as a `\u` escape, and so are U+2028 and U+2029, so no captured text or
 * guidance can end the script element, open a comment in it or become markup.
 */
export function walkthroughHtml(template: string, data: WalkthroughExport): string {
  const [before, after, ...rest] = template.split(walkthroughPlaceholder);
  if (after === undefined || rest.length > 0)
    throw new Error("the standalone reader template must have exactly one data slot");
  const json = JSON.stringify(encodeExport(data)).replace(
    /[<>&\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `${before}${json}${after}`;
}

/** The standalone file of an approved walkthrough, stamped now, built from the installed reader. */
export const exportFile = Effect.fn("exportFile")(function* (approved: {
  readonly sessionId: string;
  readonly approval: string;
  readonly walkthrough: Walkthrough;
  readonly contents: Readonly<Record<string, string>>;
}) {
  const path = yield* ExportTemplate;
  const exportedAt = DateTime.formatIso(yield* DateTime.now);
  const { walkthrough, contents } = approved;
  const html = yield* Effect.tryPromise({
    try: async () =>
      walkthroughHtml(await readFile(path, "utf8"), {
        gyst: daemonVersion,
        exportedAt,
        walkthrough,
        contents,
      }),
    catch: (cause) =>
      new InternalError({
        message: "the standalone walkthrough reader is not installed; reinstall @gyst/cli",
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  return {
    sessionId: approved.sessionId,
    snapshotId: walkthrough.snapshotId,
    approval: approved.approval,
    exportedAt,
    name: `gyst-walkthrough-${walkthrough.snapshotId.slice(0, 12)}.html`,
    html,
  } satisfies ExportPayload;
});
