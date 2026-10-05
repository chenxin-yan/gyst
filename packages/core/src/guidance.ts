/* eslint-disable no-control-regex -- Explicitly recognize unsafe controls in authored text. */
import { Schema } from "effect";

/** Project-relative `/`-separated metadata; it names content and is never resolved as a host path. */
export const LogicalPathSchema = Schema.String.check(
  Schema.makeFilter(
    (path) =>
      (!path.includes("\0") &&
        path
          .split("/")
          .every((segment) => segment !== "" && segment !== "." && segment !== "..")) ||
      "path must be project-relative with no empty, `.` or `..` segments",
  ),
);

/** 1-based. A line is the bytes up to and including its LF, or up to the end of content. */
export const LineNumberSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const CodeSideSchema = Schema.Literals(["old", "new"]);
export type CodeSide = typeof CodeSideSchema.Type;

const codeRangeFields = {
  path: LogicalPathSchema,
  side: CodeSideSchema,
  startLine: LineNumberSchema,
  endLine: LineNumberSchema,
};
const ordered = (range: { readonly startLine: number; readonly endLine: number }) =>
  range.endLine >= range.startLine || "endLine is before startLine";

/** One contiguous, inclusive line range of one side of a file. */
export const CodeRangeSchema = Schema.Struct(codeRangeFields).check(Schema.makeFilter(ordered));
export type CodeRange = typeof CodeRangeSchema.Type;

/** A range pinned to the snapshot it was validated against; a later snapshot never rebinds it. */
export const CapturedRangeSchema = Schema.Struct({
  snapshotId: Schema.String,
  ...codeRangeFields,
}).check(Schema.makeFilter(ordered));
export type CapturedRange = typeof CapturedRangeSchema.Type;

/**
 * Authored Markdown. It has no length cap; it only refuses text that could hide or forge content
 * in a terminal or browser: controls other than tab and LF, line separators and bidi overrides.
 */
export const MarkdownSchema = Schema.String.check(
  Schema.makeFilter(
    (text) =>
      (text.trim().length > 0 &&
        !/[\x00-\x08\x0b-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/.test(text)) ||
      "Markdown must be non-blank, without controls other than tab and LF or directional overrides",
  ),
);

// Receipts store the same shapes with each Markdown text replaced by an index.
export const guidanceTextFields = <Text extends Schema.Top>(markdown: Text) => ({
  markdown,
  references: Schema.Array(CapturedRangeSchema),
});
export const noteFields = <Text extends Schema.Top>(markdown: Text) => ({
  id: Schema.String,
  anchor: CapturedRangeSchema,
  ...guidanceTextFields(markdown),
});
/** An overview: the walkthrough's or one group's. */
export const GuidanceTextSchema = Schema.Struct(guidanceTextFields(MarkdownSchema));
export type GuidanceText = typeof GuidanceTextSchema.Type;
export const NoteSchema = Schema.Struct(noteFields(MarkdownSchema));
export type Note = typeof NoteSchema.Type;

const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The line numbers a hunk removes (old side) and adds (new side); context lines are not changes. */
export function changedLinesOf(hunk: { readonly patch: string }): Record<CodeSide, number[]> {
  const changed: Record<CodeSide, number[]> = { old: [], new: [] };
  const [header, ...body] = hunk.patch.split("\n");
  const start = hunkHeader.exec(header ?? "");
  if (!start) return changed;
  let oldLine = Number(start[1]);
  let newLine = Number(start[2]);
  for (const line of body) {
    if (line.startsWith("-")) changed.old.push(oldLine++);
    else if (line.startsWith("+")) changed.new.push(newLine++);
    else if (line.startsWith(" ")) {
      oldLine++;
      newLine++;
    }
  }
  return changed;
}

/**
 * The hunks with a changed line inside `range`, on its side only: a pure deletion is reachable
 * from the old side alone.
 */
export const anchoredHunkIds = (
  hunks: readonly { readonly id: string; readonly file: string; readonly patch: string }[],
  range: CodeRange,
): string[] =>
  hunks
    .filter(
      (hunk) =>
        hunk.file === range.path &&
        changedLinesOf(hunk)[range.side].some(
          (line) => line >= range.startLine && line <= range.endLine,
        ),
    )
    .map(({ id }) => id);

/**
 * The only external links guidance may carry: absolute `http(s)` URLs. The URL must already be
 * entity-decoded, as a Markdown parser leaves it, so `&#106;avascript:` arrives as `javascript:`.
 */
export const isWebUrl = (url: string) => {
  if (!/^https?:\/\/[^/\s]/i.test(url) || !URL.canParse(url)) return false;
  const { protocol } = new URL(url);
  return protocol === "http:" || protocol === "https:";
};

const referenceHref = /^gyst:(old|new)\/([^#]+)#L([1-9]\d*)(?:-L([1-9]\d*))?$/;

/** Parses a `gyst:<old|new>/<path>#L<start>[-L<end>]` link; anything else is not a reference. */
export function parseReferenceHref(href: string): CodeRange | undefined {
  const match = referenceHref.exec(href);
  if (!match) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(match[2]!);
  } catch {
    return undefined;
  }
  const range = {
    path,
    side: match[1] as CodeSide,
    startLine: Number(match[3]),
    endLine: Number(match[4] ?? match[3]),
  };
  return Schema.is(CodeRangeSchema)(range) ? range : undefined;
}
