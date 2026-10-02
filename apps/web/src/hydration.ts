// Which changed files to load in full, and when: the window the reader sees plus a few items
// around it, a bounded number of files at a time. No React or DOM here, so it is unit tested on
// its own.

/** Items past each edge of the visible ones that load too, so a short scroll finds them ready. */
export const nearbyItems = 3;

/**
 * Files loading at once. Each reads its two sides a 64 KiB page at a time, so this keeps four
 * `code` requests in flight, leaving two of a browser's six connections per origin for the files
 * pages and Viewed saves.
 */
export const hydrationConcurrency = 2;

/**
 * The files to load, most wanted first: the visible ones in reading order, then up to `nearby`
 * after the last and before the first, nearest first. `order` lists the files that can load.
 */
export function hydrationWindow(
  order: readonly string[],
  visible: readonly string[],
  nearby: number,
): string[] {
  const shown = new Set(visible);
  const indexes = order.flatMap((path, index) => (shown.has(path) ? [index] : []));
  if (indexes.length === 0) return [];
  const first = indexes[0]!;
  const last = indexes.at(-1)!;
  return [
    ...indexes.map((index) => order[index]!),
    ...order.slice(last + 1, last + 1 + nearby),
    ...order.slice(Math.max(0, first - nearby), first).toReversed(),
  ];
}

/**
 * Loads the wanted files, at most `concurrency` at a time, in the order last given to `want`. A
 * result reaches `onLoaded` only while its file is still wanted and the scheduler runs, so a file
 * that left the window, or a reader that went away, never takes it. A failed file is not retried
 * here; the reader retries it on demand.
 */
export function hydrationScheduler<Loaded>(options: {
  concurrency: number;
  load: (path: string) => Promise<Loaded>;
  onLoaded: (path: string, loaded: Loaded) => void;
}) {
  let wanted: readonly string[] = [];
  let stopped = false;
  const running = new Set<string>();
  // Loaded or failed: not asked again until forgotten.
  const settled = new Set<string>();
  const pump = () => {
    for (const path of wanted) {
      if (stopped || running.size >= options.concurrency) return;
      if (running.has(path) || settled.has(path)) continue;
      running.add(path);
      const finish = (loaded?: { value: Loaded }) => {
        running.delete(path);
        if (stopped) return;
        if (loaded === undefined || wanted.includes(path)) settled.add(path);
        if (loaded !== undefined && wanted.includes(path)) options.onLoaded(path, loaded.value);
        pump();
      };
      options.load(path).then(
        (value) => finish({ value }),
        () => finish(),
      );
    }
  };
  return {
    want(paths: readonly string[]) {
      wanted = paths;
      pump();
    },
    /** Lets a file load again, after its contents were dropped. */
    forget(path: string) {
      settled.delete(path);
    },
    inFlight: () => running.size,
    stop() {
      stopped = true;
    },
  };
}
