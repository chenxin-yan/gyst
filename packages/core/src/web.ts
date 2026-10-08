export const webPaths = {
  operation: "/api/operation",
  events: "/api/events",
} as const;

/**
 * The standalone walkthrough template's one data slot: a JSON script element with this id whose
 * whole text is `placeholder`, which the daemon replaces with an export's data.
 */
export const walkthroughSlot = {
  id: "gyst-walkthrough",
  placeholder: "__GYST_WALKTHROUGH__",
} as const;
