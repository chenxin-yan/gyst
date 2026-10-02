import { describe, expect, it } from "vite-plus/test";
import { contentLoader, hydrationWindow } from "./hydration.ts";
import { PagingStopped } from "./reader.ts";

const order = ["a", "b", "c", "d", "e", "f", "g", "h"];

describe("hydrationWindow", () => {
  it("wants the visible files first, then the nearby ones after and before", () => {
    expect(hydrationWindow(order, ["d", "e"], 2)).toEqual(["d", "e", "f", "g", "c", "b"]);
    expect(hydrationWindow(order, ["a"], 2)).toEqual(["a", "b", "c"]);
    expect(hydrationWindow(order, ["h"], 3)).toEqual(["h", "g", "f", "e"]);
  });

  it("wants nothing while no loadable file is visible", () => {
    expect(hydrationWindow(order, ["logo.bin"], 2)).toEqual([]);
    expect(hydrationWindow(order, [], 2)).toEqual([]);
  });
});

/**
 * A read per path that settles when the test says so; `paged` reads a second page if wanted, and
 * otherwise stops as `capturedText` does.
 */
function deferredReads() {
  const pending = new Map<string, { resolve: (value: string) => void; reject: () => void }>();
  const started: string[] = [];
  const read = (path: string, wanted: () => boolean) =>
    new Promise<string>((resolve, reject) => {
      started.push(path);
      pending.set(path, {
        resolve: (value) => {
          if (!path.startsWith("paged")) resolve(value);
          else if (!wanted()) reject(new PagingStopped("the file left the window"));
          else {
            started.push(`${path} page 2`);
            resolve(value);
          }
        },
        reject: () => reject(new Error("offline")),
      });
    });
  return { pending, started, read };
}
const tick = () => new Promise((resolve) => setTimeout(resolve));

describe("contentLoader", () => {
  it("loads the wanted files in order, never more than the concurrency at once", async () => {
    const { pending, started, read } = deferredReads();
    const loaded: string[] = [];
    const loader = contentLoader<string>({
      concurrency: 2,
      read,
      onLoaded: (path, value) => loaded.push(`${path}=${value}`),
    });
    loader.want(["a", "b", "c"]);
    expect(started).toEqual(["a", "b"]);
    expect(loader.inFlight()).toBe(2);
    pending.get("a")!.resolve("A");
    await tick();
    expect(started).toEqual(["a", "b", "c"]);
    expect(loader.inFlight()).toBe(2);
    pending.get("b")!.resolve("B");
    pending.get("c")!.resolve("C");
    await tick();
    expect(loaded).toEqual(["a=A", "b=B", "c=C"]);
    // Loaded files are not asked again.
    loader.want(["a", "b", "c"]);
    expect(started).toHaveLength(3);
  });

  it("admits the renderer's requests under the same limit, ahead of eager loads", async () => {
    const { pending, started, read } = deferredReads();
    const loaded: string[] = [];
    const loader = contentLoader<string>({
      concurrency: 2,
      read,
      onLoaded: (path) => loaded.push(path),
    });
    loader.want(["a", "b", "c", "d"]);
    const opened = loader.request("e");
    // A request for a file already reading joins it.
    const joined = loader.request("a");
    expect(started).toEqual(["a", "b"]);
    expect(loader.inFlight()).toBe(2);
    pending.get("b")!.resolve("B");
    await tick();
    expect(started).toEqual(["a", "b", "e"]);
    expect(loader.inFlight()).toBe(2);
    pending.get("a")!.resolve("A");
    pending.get("e")!.resolve("E");
    expect(await joined).toBe("A");
    expect(await opened).toBe("E");
    await tick();
    expect(started).toEqual(["a", "b", "e", "c", "d"]);
    // A requested file's result goes to the renderer, not to `onLoaded`.
    expect(loaded).toEqual(["b"]);
  });

  it("drops a result for a file that left the window, and reads it again on return", async () => {
    const { pending, started, read } = deferredReads();
    const loaded: string[] = [];
    const loader = contentLoader<string>({
      concurrency: 1,
      read,
      onLoaded: (path) => loaded.push(path),
    });
    loader.want(["a"]);
    loader.want(["b"]);
    pending.get("a")!.resolve("A");
    await tick();
    expect(loaded).toEqual([]);
    expect(started).toEqual(["a", "b"]);
    loader.want(["a"]);
    pending.get("b")!.resolve("B");
    await tick();
    expect(started).toEqual(["a", "b", "a"]);
    expect(loaded).toEqual([]);
  });

  it("recomputes the window on a selection change while the visible files stay", async () => {
    const { pending, read } = deferredReads();
    const loaded: string[] = [];
    const loader = contentLoader<string>({
      concurrency: 2,
      read,
      onLoaded: (path) => loaded.push(path),
    });
    loader.want(hydrationWindow(["a", "b", "c"], ["a"], 3));
    // Selecting a alone: the same visible files, a smaller window.
    loader.want(hydrationWindow(["a"], ["a"], 3));
    pending.get("a")!.resolve("A");
    pending.get("b")!.resolve("B");
    await tick();
    expect(loaded).toEqual(["a"]);
  });

  it("loads a requested file eagerly on return when its result landed after it left", async () => {
    const { pending, started, read } = deferredReads();
    const loaded: string[] = [];
    const loader = contentLoader<string>({
      concurrency: 1,
      read,
      onLoaded: (path) => loaded.push(path),
    });
    loader.want(["a"]);
    const requested = loader.request("a");
    // The reader leaves a before its read lands, and the renderer drops the result: not adopted.
    loader.want([]);
    pending.get("a")!.resolve("A");
    expect(await requested).toBe("A");
    await tick();
    loader.want(["a"]);
    expect(started).toEqual(["a", "a"]);
    pending.get("a")!.resolve("A");
    await tick();
    expect(loaded).toEqual(["a"]);
  });

  it("loads a requested file eagerly on the next report when the renderer dropped its result", async () => {
    const { pending, started, read } = deferredReads();
    const loaded: string[] = [];
    const loader = contentLoader<string>({
      concurrency: 1,
      read,
      onLoaded: (path) => loaded.push(path),
    });
    loader.want(["a", "b"]);
    const requested = loader.request("a");
    pending.get("a")!.resolve("A");
    expect(await requested).toBe("A");
    await tick();
    // Its result went to the renderer, which may adopt it: no second read until the next report.
    expect(started).toEqual(["a", "b"]);
    pending.get("b")!.resolve("B");
    await tick();
    expect(started).toEqual(["a", "b"]);
    // The renderer dropped it, so the next report still lists it: loaded once more, eagerly.
    loader.want(["a", "b"]);
    expect(started).toEqual(["a", "b", "a"]);
    pending.get("a")!.resolve("A");
    await tick();
    expect(loaded).toEqual(["b", "a"]);
    loader.want(["a", "b"]);
    expect(started).toEqual(["a", "b", "a"]);
  });

  it("leaves a failed wanted file to the reader's retry", async () => {
    const { pending, started, read } = deferredReads();
    const loader = contentLoader<string>({ concurrency: 1, read, onLoaded: () => {} });
    loader.want(["a"]);
    pending.get("a")!.reject();
    await tick();
    loader.want(["a"]);
    expect(started).toEqual(["a"]);
  });

  it("once stopped, applies nothing, pages no further and fails waiting requests", async () => {
    const { pending, started, read } = deferredReads();
    const loaded: string[] = [];
    const loader = contentLoader<string>({
      concurrency: 1,
      read,
      onLoaded: (path) => loaded.push(path),
    });
    loader.want(["paged"]);
    const waiting = loader.request("b");
    loader.stop();
    await expect(waiting).rejects.toBeInstanceOf(PagingStopped);
    // The held first page lands after the stop: no second page is read.
    pending.get("paged")!.resolve("A");
    await tick();
    expect(started).toEqual(["paged"]);
    expect(loaded).toEqual([]);
    await expect(loader.request("c")).rejects.toBeInstanceOf(PagingStopped);
  });

  it("loads again after stop and start, keeping a read held across them within the bound", async () => {
    const { pending, started, read } = deferredReads();
    const loaded: string[] = [];
    const loader = contentLoader<string>({
      concurrency: 1,
      read,
      onLoaded: (path) => loaded.push(path),
    });
    loader.want(["paged"]);
    // StrictMode's effect replay: the held read keeps its slot.
    loader.stop();
    loader.start();
    loader.want(["paged", "b"]);
    const requested = loader.request("c");
    expect(started).toEqual(["paged"]);
    expect(loader.inFlight()).toBe(1);
    // Wanted again, the held read pages on.
    pending.get("paged")!.resolve("A");
    await tick();
    expect(loaded).toEqual(["paged"]);
    expect(started).toEqual(["paged", "paged page 2", "c"]);
    expect(loader.inFlight()).toBe(1);
    pending.get("c")!.resolve("C");
    expect(await requested).toBe("C");
    await tick();
    expect(started).toEqual(["paged", "paged page 2", "c", "b"]);
  });

  it("reads a file a stop cancelled again once started and wanted, not as a failure", async () => {
    const { pending, started, read } = deferredReads();
    const loaded: string[] = [];
    const loader = contentLoader<string>({
      concurrency: 1,
      read,
      onLoaded: (path) => loaded.push(path),
    });
    loader.want(["paged"]);
    loader.stop();
    // The first page lands while stopped, so the read stops; it drains after the restart.
    pending.get("paged")!.resolve("A");
    loader.start();
    loader.want(["paged"]);
    await tick();
    expect(started).toEqual(["paged", "paged"]);
    pending.get("paged")!.resolve("A");
    await tick();
    expect(loaded).toEqual(["paged"]);
  });
});
