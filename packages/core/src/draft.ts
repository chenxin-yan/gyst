import type { Note } from "./guidance.ts";
import type {
  ApplyReceipt,
  ConversationReceipt,
  Group,
  Hunk,
  PickupReceipt,
  RefreshReceipt,
  Session,
  ViewedReceipt,
} from "./session.ts";
import type { Draft, Thread } from "./thread.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type MutableHunk = Mutable<Hunk>;
export type MutableGroup = Mutable<Omit<Group, "hunkIds" | "files" | "notes">> & {
  hunkIds: string[];
  files: string[];
  notes: Note[];
};
export type MutableSession = Mutable<
  Omit<
    Session,
    | "hunks"
    | "groups"
    | "viewedHunkIds"
    | "receiptTexts"
    | "applyReceipts"
    | "viewedReceipts"
    | "refreshReceipts"
    | "threads"
    | "drafts"
    | "conversationReceipts"
    | "pickupReceipts"
  >
> & {
  hunks: MutableHunk[];
  groups: MutableGroup[];
  viewedHunkIds: string[];
  receiptTexts: string[];
  applyReceipts: ApplyReceipt[];
  viewedReceipts: ViewedReceipt[];
  refreshReceipts: RefreshReceipt[];
  threads: MutableThread[];
  drafts: Mutable<Draft>[];
  conversationReceipts: ConversationReceipt[];
  pickupReceipts: PickupReceipt[];
};
export type MutableThread = Mutable<Omit<Thread, "messages">> & {
  messages: Thread["messages"][number][];
};

export function draftOf(session: Session): MutableSession {
  const {
    receiptTexts,
    applyReceipts,
    viewedReceipts,
    refreshReceipts,
    conversationReceipts,
    pickupReceipts,
    ...live
  } = session;
  // SAFETY: structuredClone returns a detached copy, so dropping readonly cannot alias the caller's
  // session. Receipt history is append-only and its entries are never mutated, so sharing them is safe.
  return {
    ...(structuredClone(live) as Mutable<typeof live>),
    receiptTexts: [...receiptTexts],
    applyReceipts: [...applyReceipts],
    viewedReceipts: [...viewedReceipts],
    refreshReceipts: [...refreshReceipts],
    conversationReceipts: [...conversationReceipts],
    pickupReceipts: [...pickupReceipts],
  } as MutableSession;
}
