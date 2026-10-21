import type { PullRequest, PullRequestStatus } from "@gyst/core/wire";
import { describe, expect, it } from "vite-plus/test";
import { stackRows, timeAgo, triggerLabel, verificationText } from "./stack.ts";

const now = new Date("2026-01-01T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

const pr = (number: number, fields: Partial<PullRequest> = {}): PullRequest => ({
  number,
  title: `Layer ${number}`,
  description: "",
  state: "open",
  url: `https://github.com/acme/widgets/pull/${number}`,
  baseRefName: "main",
  headRefName: `branch-${number}`,
  ...fields,
});

/** B (#2) selected in A-B-C, given out of order, with only B and C opened. */
const stacked = (fields: Partial<PullRequestStatus> = {}): PullRequestStatus => ({
  pullRequest: pr(2),
  stack: {
    verifiedAt: minutesAgo(5),
    membership: "stacked",
    number: 7,
    baseRefName: "main",
    layers: [
      { position: 1, pullRequest: pr(1, { state: "merged" }) },
      { position: 2, pullRequest: pr(2) },
      { position: 3, pullRequest: pr(3, { state: "closed" }) },
    ],
  },
  unavailable: null,
  selected: 2,
  sessions: [
    { number: 2, sessionId: "b", hunkCount: 4, viewedCount: 1, openThreads: 0 },
    { number: 3, sessionId: "c", hunkCount: 2, viewedCount: 2, openThreads: 1 },
  ],
  ...fields,
});

describe("stackRows", () => {
  it("lists the layers in position order with their state and marks only the selected PR current", () => {
    const rows = stackRows(stacked(), 1);
    expect(
      rows.map((row) => [row.position, row.number, row.title, row.state, row.current]),
    ).toEqual([
      [1, 1, "Layer 1", "merged", false],
      [2, 2, "Layer 2", "open", true],
      [3, 3, "Layer 3", "closed", false],
    ]);
  });

  it("gives an unopened layer no session, so it never reads as zero or complete Viewed", () => {
    const [unopened] = stackRows(stacked(), 1);
    expect(unopened!.session).toBeUndefined();
  });

  it("counts Viewed hunks of the opened layers' own sessions", () => {
    const [, b, c] = stackRows(stacked(), 1);
    expect(b!.session).toEqual({ id: "b", viewed: 1, total: 4, open: 0 });
    // Every hunk Viewed with a thread still open: the counts stay apart.
    expect(c!.session).toEqual({ id: "c", viewed: 2, total: 2, open: 1 });
  });

  it("counts the selected layer's Viewed from the reader's settled progress, newer than status", () => {
    const [a, b, c] = stackRows(stacked(), 3);
    expect([a!.session, b!.session, c!.session]).toEqual([
      undefined,
      { id: "b", viewed: 3, total: 4, open: 0 },
      { id: "c", viewed: 2, total: 2, open: 1 },
    ]);
  });

  it("shows the selected PR's latest read, which a recheck may refresh while discovery fails", () => {
    const status = stacked({
      pullRequest: pr(2, { title: "Renamed", state: "merged" }),
      unavailable: { at: minutesAgo(0), reason: "github_failed" },
    });
    expect(stackRows(status, 1)[1]).toMatchObject({ title: "Renamed", state: "merged" });
  });

  it("lists only the selected PR, without a position, when it stands alone or is unknown", () => {
    const sessions = [{ number: 2, sessionId: "b", hunkCount: 3, viewedCount: 0, openThreads: 0 }];
    const standalone = stacked({
      stack: { verifiedAt: minutesAgo(1), membership: "none" },
      sessions,
    });
    const unknown = stacked({
      stack: null,
      unavailable: { at: minutesAgo(1), reason: "gh_unauthenticated" },
      sessions,
    });
    for (const status of [standalone, unknown])
      expect(stackRows(status, 0)).toEqual([
        {
          position: undefined,
          number: 2,
          title: "Layer 2",
          state: "open",
          current: true,
          session: { id: "b", viewed: 0, total: 3, open: 0 },
        },
      ]);
  });
});

describe("triggerLabel", () => {
  it("names the selected layer's position, standalone or unknown membership", () => {
    expect(triggerLabel(stacked())).toBe("Stack 2/3");
    expect(
      triggerLabel(stacked({ stack: { verifiedAt: minutesAgo(1), membership: "none" } })),
    ).toBe("Standalone PR");
    expect(
      triggerLabel(
        stacked({ stack: null, unavailable: { at: minutesAgo(1), reason: "no_access" } }),
      ),
    ).toBe("Stack unknown");
  });

  it("keeps the last verified position after a failed recheck", () => {
    const status = stacked({ unavailable: { at: minutesAgo(0), reason: "github_failed" } });
    expect(triggerLabel(status)).toBe("Stack 2/3");
  });
});

describe("verificationText", () => {
  it("says when a stack or standalone membership was verified", () => {
    expect(verificationText(stacked(), now)).toBe("Verified 5 minutes ago");
    const standalone = stacked({ stack: { verifiedAt: minutesAgo(0), membership: "none" } });
    expect(verificationText(standalone, now)).toBe("Verified just now");
  });

  it("shows the last verified stack only as of its verification after a failure, never as verified", () => {
    const text = verificationText(
      stacked({ unavailable: { at: minutesAgo(1), reason: "github_failed" } }),
      now,
    );
    expect(text).toBe(
      "Couldn't verify the stack (the GitHub request failed, 1 minute ago); showing it as of 5 minutes ago",
    );
    expect(text).not.toMatch(/^Verified/);
  });

  it("says membership is unknown, and why, when discovery never succeeded", () => {
    const text = verificationText(
      stacked({ stack: null, unavailable: { at: minutesAgo(120), reason: "gh_missing" } }),
      now,
    );
    expect(text).toBe(
      "Stack membership unknown: GitHub CLI isn't installed on the gyst host, 2 hours ago",
    );
  });
});

describe("timeAgo", () => {
  it("rounds down to minutes, hours or days and reads a future time as just now", () => {
    expect(timeAgo(minutesAgo(0.5), now)).toBe("just now");
    expect(timeAgo(minutesAgo(-3), now)).toBe("just now");
    expect(timeAgo(minutesAgo(59), now)).toBe("59 minutes ago");
    expect(timeAgo(minutesAgo(61), now)).toBe("1 hour ago");
    expect(timeAgo(minutesAgo(3 * 24 * 60), now)).toBe("3 days ago");
  });
});
