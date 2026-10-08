import type { GitHubUnavailableReason, PullRequest, PullRequestStatus } from "@gyst/core/wire";

/**
 * One PR in the switcher. `position` is its layer in a known stack, undefined when the selected PR
 * stands alone or its membership is unknown. `session` is its saved session; an unopened layer has
 * none, so it never shows counts.
 */
export type StackRow = {
  position: number | undefined;
  number: number;
  title: string;
  state: PullRequest["state"];
  current: boolean;
  // #92 adds the unresolved-thread count here.
  session: { id: string; viewed: number; total: number } | undefined;
};

/**
 * The switcher's rows in layer order, the selected PR marked current. A PR without a known stack
 * (standalone or unknown membership) lists only itself. The selected PR's own details come from its
 * latest read, which a recheck may have refreshed even when stack discovery failed, and its Viewed
 * count from the reader's settled progress, which its own writes keep newer than that read.
 */
export const stackRows = (status: PullRequestStatus, selectedViewed: number): StackRow[] => {
  const saved = new Map(status.sessions.map((entry) => [entry.number, entry]));
  const row = (position: number | undefined, pullRequest: PullRequest): StackRow => {
    const current = pullRequest.number === status.selected;
    const { title, state } = current ? status.pullRequest : pullRequest;
    const entry = saved.get(pullRequest.number);
    return {
      position,
      number: pullRequest.number,
      title,
      state,
      current,
      session: entry && {
        id: entry.sessionId,
        viewed: current ? selectedViewed : entry.viewedCount,
        total: entry.hunkCount,
      },
    };
  };
  return status.stack?.membership === "stacked"
    ? status.stack.layers.map((layer) => row(layer.position, layer.pullRequest))
    : [row(undefined, status.pullRequest)];
};

/** The compact header trigger: the selected layer's position, or what is known instead. */
export const triggerLabel = (status: PullRequestStatus) => {
  const { stack } = status;
  if (stack === null) return "Stack unknown";
  if (stack.membership === "none") return "Standalone PR";
  const layer = stack.layers.find((entry) => entry.pullRequest.number === status.selected);
  return `Stack ${layer?.position}/${stack.layers.length}`;
};

const reasons = {
  gh_missing: "GitHub CLI isn't installed on the gyst host",
  gh_unauthenticated: "GitHub CLI isn't signed in on the gyst host",
  no_access: "the gh account can't read this PR",
  github_failed: "the GitHub request failed",
} satisfies Record<GitHubUnavailableReason, string>;

/** How long ago an ISO time was, in words; a time ahead of `now` (clock skew) reads as just now. */
export const timeAgo = (at: string, now: Date) => {
  const minutes = Math.floor((now.getTime() - Date.parse(at)) / 60_000);
  const count = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"} ago`;
  if (!(minutes >= 1)) return "just now";
  if (minutes < 60) return count(minutes, "minute");
  if (minutes < 24 * 60) return count(Math.floor(minutes / 60), "hour");
  return count(Math.floor(minutes / (24 * 60)), "day");
};

/**
 * Whether the stack shown is verified and since when. After a failed recheck the last verified
 * stack is still shown, but only "as of" its verification: it is neither fresh nor a removal.
 */
export const verificationText = (status: PullRequestStatus, now: Date) => {
  const { stack, unavailable } = status;
  if (stack !== null && unavailable === null) return `Verified ${timeAgo(stack.verifiedAt, now)}`;
  const failed = unavailable
    ? `${reasons[unavailable.reason]}, ${timeAgo(unavailable.at, now)}`
    : "";
  if (stack === null) return `Stack membership unknown: ${failed}`;
  return `Couldn't verify the stack (${failed}); showing it as of ${timeAgo(stack.verifiedAt, now)}`;
};
