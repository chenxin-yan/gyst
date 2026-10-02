// Which changed files to load in full, and when: the window the reader sees plus a few items
// around it, a bounded number of files at a time. No React or DOM here, so it is unit tested on
// its own.
import { PagingStopped } from "./reader.ts";

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
 * Every load of changed files' captured contents, eager and the renderer's alike: at most
 * `concurrency` files read at once, each holding its slot until its read settles. A renderer
 * `request` (a range the reader opened) takes the next free slot before any eager load; eager
 * loads follow the order last given to `want`. A file pages on only while wanted or requested
 * and not stopped. Nothing is kept here: an eager result reaches `onLoaded` only while its file
 * is still wanted, otherwise it is dropped, and a request's goes to its caller. An eagerly loaded
 * or failed file is not loaded eagerly again (the reader retries a failure on demand). The
 * renderer may adopt a request's result or drop it, so a requested file waits for the next `want`:
 * one that still lists it (it was dropped) loads it eagerly once more.
 */
export function contentLoader<Loaded>(options: {
  concurrency: number;
  /** Reads one file; `wanted` says whether to read its next page. */
  read: (path: string, wanted: () => boolean) => Promise<Loaded>;
  onLoaded: (path: string, loaded: Loaded) => void;
}) {
  let order: readonly string[] = [];
  let wanted = new Set<string>();
  let stopped = false;
  const running = new Set<string>();
  // The renderer's requests, oldest first, waiting for a slot or reading.
  const requests = new Map<string, PromiseWithResolvers<Loaded>>();
  // Eagerly loaded and failed files.
  const settled = new Set<string>();
  const isStopped = (result: { value: Loaded } | { error: unknown }) =>
    "error" in result && result.error instanceof PagingStopped;
  const isWanted = (path: string) => !stopped && (wanted.has(path) || requests.has(path));
  const start = (path: string) => {
    running.add(path);
    const finish = (result: { value: Loaded } | { error: unknown }) => {
      running.delete(path);
      const request = requests.get(path);
      requests.delete(path);
      if ("value" in result) request?.resolve(result.value);
      else request?.reject(result.error);
      if (stopped) return;
      // The renderer adopts a request's result or drops it; the next `want` says which.
      // A read stopped on purpose is not a failure: it loads again once wanted.
      if (request !== undefined && "value" in result) wanted.delete(path);
      else if ((request !== undefined || wanted.has(path)) && !isStopped(result)) settled.add(path);
      if (request === undefined && wanted.has(path) && "value" in result)
        options.onLoaded(path, result.value);
      pump();
    };
    options
      .read(path, () => isWanted(path))
      .then(
        (value) => finish({ value }),
        (error: unknown) => finish({ error }),
      );
  };
  const pump = () => {
    if (stopped) return;
    while (running.size < options.concurrency) {
      const next =
        [...requests.keys()].find((path) => !running.has(path)) ??
        order.find((path) => wanted.has(path) && !running.has(path) && !settled.has(path));
      if (next === undefined) return;
      start(next);
    }
  };
  return {
    want(paths: readonly string[]) {
      order = paths;
      wanted = new Set(paths);
      pump();
    },
    /** The renderer's load of a file, which waits only for a free slot. */
    request(path: string): Promise<Loaded> {
      if (stopped) return Promise.reject(new PagingStopped("the reader went away"));
      let request = requests.get(path);
      if (request === undefined) {
        request = Promise.withResolvers<Loaded>();
        requests.set(path, request);
        pump();
      }
      return request.promise;
    },
    inFlight: () => running.size,
    /**
     * Loads again after a `stop`, as React replays an effect. Reads still in flight keep their
     * slots, and one wanted again pages on.
     */
    start() {
      stopped = false;
      pump();
    },
    /** Wants nothing more until `start`: reads stop after their current page, waiting requests fail. */
    stop() {
      stopped = true;
      order = [];
      wanted = new Set();
      for (const [path, request] of requests)
        if (!running.has(path)) {
          requests.delete(path);
          request.reject(new PagingStopped("the reader went away"));
        }
    },
  };
}
