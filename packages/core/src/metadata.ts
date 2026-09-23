/* eslint-disable no-control-regex -- Explicitly recognize unsafe terminal controls. */
import { Schema } from "effect";

export const TITLE_MAX_CODE_POINTS = 120;
export const OVERVIEW_MAX_BYTES = 64 * 1024;
// Keep Markdown whitespace, never pass terminal controls or directional overrides to the renderer.
export const sanitizeOverview = (text: string): string =>
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
export const OverviewSchema = Schema.String.check(
  Schema.makeFilter(
    (overview) =>
      (sanitizeOverview(overview).trim().length > 0 &&
        new TextEncoder().encode(overview).length <= OVERVIEW_MAX_BYTES) ||
      "overview must be nonempty and at most 64 KiB UTF-8",
  ),
);
export const metadataFields = { title: TitleSchema, overview: OverviewSchema };
export const MetadataSchema = Schema.Struct(metadataFields);
