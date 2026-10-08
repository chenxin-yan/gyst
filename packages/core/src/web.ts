export const webPaths = {
  operation: "/api/operation",
  events: "/api/events",
} as const;

/** The id of the standalone walkthrough template's one data slot: a JSON script element. */
export const walkthroughSlotId = "gyst-walkthrough";

/**
 * The whole text of that slot in the template, which the daemon replaces with an export's data.
 * Apart from the build and the daemon, nothing names it, so the template's code never contains it.
 */
export const walkthroughPlaceholder = "__GYST_WALKTHROUGH__";
