import type { ApplyReceipt, Group, Hunk, Session, ViewedReceipt } from "./session.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableHunk = Mutable<Hunk>;
type MutableGroup = Mutable<Omit<Group, "hunkIds">> & { hunkIds: string[] };
export type MutableSession = Mutable<
  Omit<
    Session,
    "hunks" | "groups" | "viewedHunkIds" | "receiptNoteTexts" | "applyReceipts" | "viewedReceipts"
  >
> & {
  hunks: MutableHunk[];
  groups: MutableGroup[];
  viewedHunkIds: string[];
  receiptNoteTexts: string[];
  applyReceipts: ApplyReceipt[];
  viewedReceipts: ViewedReceipt[];
};

export function draftOf(session: Session): MutableSession {
  const { receiptNoteTexts, applyReceipts, viewedReceipts, ...live } = session;
  // SAFETY: structuredClone returns a detached copy, so dropping readonly cannot alias the caller's
  // session. Receipt history is append-only and its entries are never mutated, so sharing them is safe.
  return {
    ...(structuredClone(live) as Mutable<typeof live>),
    receiptNoteTexts: [...receiptNoteTexts],
    applyReceipts: [...applyReceipts],
    viewedReceipts: [...viewedReceipts],
  } as MutableSession;
}
