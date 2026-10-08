/* eslint-disable no-control-regex -- Explicitly recognize unsafe terminal controls. */
import { Schema } from "effect";

export const TITLE_MAX_CODE_POINTS = 120;
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
