// PROTOTYPE: all experiments stay inside this lab's temporary directory.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Lsp, buildIndex, queryIndex, writeProject, versions, type Index } from "./engines.ts";
import {
  originalOld,
  originalNew,
  editedLive,
  type Files,
  type Side,
  type Position,
} from "./fixtures.ts";

export class Lab {
  root = "";
  generation = 0;
  old: Files = { ...originalOld };
  new: Files = { ...originalNew };
  live: Files = { ...originalNew };
  servers: Partial<Record<Side | "live", Lsp>> = {};
  indexes: Partial<Record<Side, Index>> = {};
  indexErrors: Partial<Record<Side, string>> = {};

  async start() {
    this.root = await mkdtemp(join(tmpdir(), "gyst-navigation-PROTOTYPE-"));
    try {
      await this.rebuild();
      return this;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async rebuild() {
    await this.stopServers();
    this.generation++;
    this.indexes = {};
    this.indexErrors = {};
    for (const side of ["old", "new", "live"] as const) {
      const root = join(this.root, side);
      await rm(root, { recursive: true, force: true });
      await mkdir(root);
      await writeProject(root, this[side]);
      const server = new Lsp(root, this[side]);
      this.servers[side] = server;
      await server.start();
      if (side !== "live") {
        try {
          this.indexes[side] = await buildIndex(root);
        } catch (error) {
          this.indexErrors[side] = String(error);
        }
      }
    }
  }

  state() {
    return {
      generation: this.generation,
      old: this.old,
      new: this.new,
      live: this.live,
      diverged: JSON.stringify(this.new) !== JSON.stringify(this.live),
      versions,
      engines: Object.fromEntries(
        Object.entries(this.servers).map(([name, server]) => [
          name,
          { startupMs: server.startupMs, serverInfo: server.serverInfo },
        ]),
      ),
      indexes: Object.fromEntries(
        Object.entries(this.indexes).map(([side, index]) => [
          side,
          { buildMs: index.buildMs, bytes: index.bytes, files: index.documents.length },
        ]),
      ),
      indexErrors: this.indexErrors,
    };
  }

  async mutate() {
    await this.setLive({ ...editedLive });
  }

  async setLive(files: Files) {
    await this.servers.live?.stop();
    this.live = { ...files };
    const root = join(this.root, "live");
    await rm(root, { recursive: true, force: true });
    await mkdir(root);
    await writeProject(root, this.live);
    const server = new Lsp(root, this.live);
    this.servers.live = server;
    await server.start();
  }

  async refresh() {
    this.old = { ...this.new };
    this.new = { ...this.live };
    await this.rebuild();
  }
  async reset() {
    this.old = { ...originalOld };
    this.new = { ...originalNew };
    this.live = { ...originalNew };
    await this.rebuild();
  }

  async query(
    side: Side,
    file: string,
    position: Position,
    kind: "definition" | "references",
    includeDeclaration: boolean,
  ) {
    const results = [];
    for (const engine of ["live", "frozen", "index"] as const) {
      const start = performance.now();
      try {
        // Comparing only positions after editing the clicked file would manufacture a symbol mapping.
        if (engine === "live" && this.live[file] !== this[side][file])
          throw new Error(
            "Clicked file differs from the live copy. Live query refused rather than guessing a position; choose a still-identical file or refresh.",
          );
        const index = this.indexes[side];
        if (engine === "index" && !index)
          throw new Error(this.indexErrors[side] ?? "Index unavailable");
        const targets =
          engine === "index"
            ? queryIndex(index!, this[side], file, position, kind, includeDeclaration)
            : await this.servers[engine === "live" ? "live" : side]!.query(
                file,
                position,
                kind,
                includeDeclaration,
              );
        results.push({
          engine,
          provenance:
            engine === "live"
              ? "Current scratch workspace — NOT the reviewed snapshot"
              : `Captured ${side} side · generation ${this.generation}`,
          ms: performance.now() - start,
          targets,
        });
      } catch (error) {
        results.push({ engine, ms: performance.now() - start, error: String(error), targets: [] });
      }
    }
    return { generation: this.generation, side, file, position, kind, results };
  }

  async stopServers() {
    await Promise.all(Object.values(this.servers).map((server) => server.stop()));
    this.servers = {};
  }
  async stop() {
    await this.stopServers();
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }
}
