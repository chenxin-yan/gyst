import { createHash } from "node:crypto";

/** A 64-bit hex identity: SHA-256 truncated to 16 hex digits. */
export const hash = (input: string) =>
  createHash("sha256").update(input).digest("hex").slice(0, 16);
