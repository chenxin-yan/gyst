/* eslint-disable no-control-regex -- Explicitly recognize unsafe terminal controls. */
import { Schema } from "effect";

export const TITLE_MAX_CODE_POINTS = 120;
export const NOTE_MAX_CODE_POINTS = 400;
// Error messages may be multiline; never pass terminal controls or directional overrides.
export const sanitizeTerminalText = (text: string): string =>
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");

export const TitleSchema = Schema.String.check(
  Schema.makeFilter(
    (title) =>
      (title.trim().length > 0 &&
        Array.from(title).length <= TITLE_MAX_CODE_POINTS &&
        !/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/.test(title)) ||
      "title must be 1–120 code points, single-line plain text without controls",
  ),
);
export const NoteTextSchema = Schema.String.check(
  Schema.makeFilter(
    (text) =>
      (text.trim().length > 0 &&
        Array.from(text).length <= NOTE_MAX_CODE_POINTS &&
        !/[\x00-\x1f\x7f-\x9f\u2028-\u202e\u2066-\u2069]/.test(text)) ||
      "note must be 1–400 code points, single-paragraph plain text without controls",
  ),
);
export const NoteSchema = Schema.Struct({ hunkId: Schema.String, text: NoteTextSchema });
export const NotesSchema = Schema.Array(NoteSchema);
export const metadataFields = { title: TitleSchema, notes: NotesSchema };
export const MetadataSchema = Schema.Struct(metadataFields);
