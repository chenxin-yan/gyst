// The change author's own explanation, beside the agent's: a PR's description or a recorded range's
// commit messages. Neither is guidance: it has no review state and never touches Viewed,
// preparation or Outdated. No React or DOM here, so each piece is unit tested on its own.
import type { Commit } from "@gyst/core/wire";

/** A commit message's subject line and the body after it, without the blank lines between. */
export function commitParts({ message }: Commit): { subject: string; body: string } {
  const newline = message.indexOf("\n");
  if (newline === -1) return { subject: message, body: "" };
  return {
    subject: message.slice(0, newline),
    body: message.slice(newline + 1).replace(/^\n+/, ""),
  };
}
