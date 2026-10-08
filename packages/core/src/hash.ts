import { Schema } from "effect";
import { createHash } from "node:crypto";
import { canonicalJson, canonicalManifestJson, type SnapshotManifest } from "./content.ts";
import { type Walkthrough, WalkthroughSchema } from "./export.ts";

// Node-only: the schemas in `content.ts` stay free of platform imports.
const sha256 = (input: string) => createHash("sha256").update(input).digest("hex");

/** A 64-bit hex identity: SHA-256 truncated to 16 hex digits. */
export const hash = (input: string) => sha256(input).slice(0, 16);

/** A snapshot's identity: the full SHA-256 of its canonical manifest JSON. */
export const snapshotIdOf = (manifest: SnapshotManifest): string =>
  sha256(canonicalManifestJson(manifest));

/**
 * What an export approval names: the full SHA-256 of the walkthrough's canonical JSON, which pins
 * its snapshot, guidance, diff and every included side's content identity.
 */
export const approvalOf = (walkthrough: Walkthrough): string =>
  sha256(canonicalJson(Schema.encodeSync(WalkthroughSchema)(walkthrough)));
