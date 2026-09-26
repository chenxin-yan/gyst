// PROTOTYPE: actual native TypeScript LSP and SCIP, not production integration.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import type { Files, Position, Range, Target } from "./fixtures.ts";

const require = createRequire(import.meta.url);
// Pin the internal decoder to the exact indexer package used to produce these artifacts.
const { scip } = require("./node_modules/@sourcegraph/scip-typescript/dist/src/scip.js");
const nativeTsc = fileURLToPath(new URL("../../node_modules/typescript/bin/tsc", import.meta.url));
const indexer = fileURLToPath(
  new URL("node_modules/@sourcegraph/scip-typescript/dist/src/main.js", import.meta.url),
);
export const versions = {
  native: require("../../node_modules/typescript/package.json").version,
  indexer: require("./node_modules/@sourcegraph/scip-typescript/package.json").version,
  indexerTypescript: require("./node_modules/typescript/package.json").version,
  node: execFileSync("node", ["--version"], { encoding: "utf8" }).trim(),
  bun: Bun.version,
};

export async function writeProject(root: string, files: Files) {
  await Promise.all(
    Object.entries(files).map(([file, text]) => writeFile(resolve(root, file), text)),
  );
  await writeFile(
    resolve(root, "package.json"),
    JSON.stringify({ name: "gyst-navigation-fixture", version: "1.0.0", private: true }),
  );
  await writeFile(
    resolve(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        allowJs: true,
        checkJs: true,
        noEmit: true,
        strict: true,
        types: [],
      },
      include: ["*.ts", "*.js"],
    }),
  );
}

export class Lsp {
  process: ChildProcessWithoutNullStreams;
  pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  id = 0;
  buffer = Buffer.alloc(0);
  stderr = "";
  capabilities: any;
  serverInfo: any;
  startupMs = 0;
  closed = false;

  constructor(
    readonly root: string,
    readonly files: Files,
  ) {
    this.process = spawn("node", [nativeTsc, "--lsp", "--stdio"], { cwd: root, stdio: "pipe" });
    this.process.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      try {
        for (;;) {
          const boundary = this.buffer.indexOf("\r\n\r\n");
          if (boundary < 0) break;
          const match = /Content-Length:\s*(\d+)/i.exec(
            this.buffer.subarray(0, boundary).toString(),
          );
          if (!match) throw new Error("Invalid language-server frame");
          const end = boundary + 4 + Number(match[1]);
          if (this.buffer.length < end) break;
          const message = JSON.parse(this.buffer.subarray(boundary + 4, end).toString());
          this.buffer = this.buffer.subarray(end);
          if (message.method && message.id !== undefined) {
            if (message.method === "workspace/configuration") {
              this.send({ id: message.id, result: message.params.items.map(() => ({})) });
            } else if (
              [
                "client/registerCapability",
                "client/unregisterCapability",
                "window/workDoneProgress/create",
              ].includes(message.method)
            ) {
              this.send({ id: message.id, result: null });
            } else if (message.method === "workspace/workspaceFolders") {
              this.send({
                id: message.id,
                result: [{ uri: pathToFileURL(root).href, name: "fixture" }],
              });
            } else {
              this.send({
                id: message.id,
                error: {
                  code: -32601,
                  message: "Not implemented in read-only navigation prototype",
                },
              });
            }
          } else if (message.id !== undefined) {
            const call = this.pending.get(message.id);
            if (!call) continue;
            clearTimeout(call.timer);
            this.pending.delete(message.id);
            if (message.error) call.reject(new Error(JSON.stringify(message.error)));
            else call.resolve(message.result);
          }
        }
      } catch (error) {
        this.fail(error as Error);
        this.process.kill();
      }
    });
    this.process.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-8000);
    });
    this.process.stdin.on("error", (error) => this.fail(error));
    this.process.on("error", (error) => {
      this.closed = true;
      this.fail(error);
    });
    this.process.on("exit", (code) => {
      this.closed = true;
      this.fail(new Error(`Language server exited (${code}): ${this.stderr}`));
    });
  }

  send(message: object) {
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.process.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(method: string, params: any): Promise<any> {
    if (this.closed) return Promise.reject(new Error("Language server is not running"));
    const id = ++this.id;
    return new Promise((fulfill, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.send({ method: "$/cancelRequest", params: { id } });
        reject(new Error(`${method} timed out after 20s`));
      }, 20_000);
      this.pending.set(id, { resolve: fulfill, reject, timer });
      this.send({ id, method, params });
    });
  }

  fail(error: Error) {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }

  async start() {
    const start = performance.now();
    const result = await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: "fixture" }],
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        workspace: { configuration: true },
        textDocument: { definition: { linkSupport: true } },
      },
    });
    this.capabilities = result.capabilities;
    this.serverInfo = result.serverInfo;
    if (this.capabilities.positionEncoding && this.capabilities.positionEncoding !== "utf-16")
      throw new Error("Prototype requires UTF-16 positions");
    if (!this.capabilities.definitionProvider || !this.capabilities.referencesProvider)
      throw new Error("Server lacks required navigation capabilities");
    this.send({ method: "initialized", params: {} });
    for (const [file, text] of Object.entries(this.files)) {
      this.send({
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: pathToFileURL(resolve(this.root, file)).href,
            languageId: file.endsWith(".js") ? "javascript" : "typescript",
            version: 1,
            text,
          },
        },
      });
    }
    this.startupMs = performance.now() - start;
    return this;
  }

  async query(
    file: string,
    position: Position,
    kind: "definition" | "references",
    includeDeclaration: boolean,
  ) {
    const raw = await this.request(`textDocument/${kind}`, {
      textDocument: { uri: pathToFileURL(resolve(this.root, file)).href },
      position,
      ...(kind === "references" ? { context: { includeDeclaration } } : {}),
    });
    const locations = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
    return locations.map((location: any): Target => {
      const uri = location.targetUri ?? location.uri;
      const range: Range = location.targetSelectionRange ?? location.range;
      let targetFile: string;
      try {
        targetFile = relative(this.root, fileURLToPath(uri));
      } catch {
        return { file: uri, range, unavailable: "Non-file target" };
      }
      if (
        targetFile.startsWith("..") ||
        isAbsolute(targetFile) ||
        !Object.hasOwn(this.files, targetFile)
      )
        return {
          file: targetFile,
          range,
          unavailable: "Outside captured fixture; not read from disk",
        };
      return { file: targetFile, range, text: this.files[targetFile] };
    });
  }

  async stop() {
    if (this.closed) return;
    // Bound cleanup even when a server stops answering shutdown.
    const kill = setTimeout(() => this.process.kill("SIGKILL"), 1000);
    try {
      await this.request("shutdown", null);
      this.send({ method: "exit" });
      this.process.stdin.end();
    } catch {
      this.process.kill("SIGKILL");
    }
    await new Promise<void>((done) => {
      if (this.closed) done();
      else this.process.once("exit", () => done());
    });
    clearTimeout(kill);
  }
}

type Occurrence = { range: number[]; symbol: string; symbol_roles: number };
type Document = { relative_path: string; occurrences: Occurrence[] };
export type Index = { documents: Document[]; buildMs: number; bytes: number };

export async function buildIndex(root: string): Promise<Index> {
  const start = performance.now();
  await new Promise<void>((done, reject) => {
    const child = spawn("node", [indexer, "index", "--cwd", root, "--no-progress-bar"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (chunk) => {
      log = (log + chunk).slice(-16000);
    });
    child.stderr.on("data", (chunk) => {
      log = (log + chunk).slice(-16000);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) done();
      else reject(new Error(`SCIP exited ${code}: ${log}`));
    });
  });
  const bytes = await readFile(resolve(root, "index.scip"));
  const decoded = scip.Index.deserializeBinary(bytes).toObject();
  return { documents: decoded.documents, buildMs: performance.now() - start, bytes: bytes.length };
}

function rangeOf(range: number[]): Range {
  return {
    start: { line: range[0]!, character: range[1]! },
    end: { line: range.length === 3 ? range[0]! : range[2]!, character: range.at(-1)! },
  };
}

export function queryIndex(
  index: Index,
  files: Files,
  file: string,
  position: Position,
  kind: "definition" | "references",
  includeDeclaration: boolean,
): Target[] {
  const source = index.documents.find((doc) => doc.relative_path === file);
  const symbols = new Set(
    source?.occurrences
      .filter((occurrence) => {
        const { start, end } = rangeOf(occurrence.range);
        return (
          occurrence.symbol &&
          (position.line > start.line ||
            (position.line === start.line && position.character >= start.character)) &&
          (position.line < end.line ||
            (position.line === end.line && position.character < end.character))
        );
      })
      .map((occurrence) => occurrence.symbol),
  );
  const targets: Target[] = [];
  // ponytail: tiny fixture scan + exact symbol identity only; relationship expansion and an indexed lookup belong in a real SCIP reader.
  for (const doc of index.documents)
    for (const occurrence of doc.occurrences) {
      if (
        !symbols.has(occurrence.symbol) ||
        (occurrence.symbol.startsWith("local ") && doc.relative_path !== file)
      )
        continue;
      const definition = (occurrence.symbol_roles & 1) !== 0;
      if (kind === "definition" ? !definition : !includeDeclaration && definition) continue;
      targets.push({
        file: doc.relative_path,
        range: rangeOf(occurrence.range),
        text: files[doc.relative_path],
        ...(files[doc.relative_path] === undefined ? { unavailable: "Source not captured" } : {}),
      });
    }
  return targets.filter(
    (target, i) =>
      targets.findIndex(
        (other) =>
          other.file === target.file &&
          JSON.stringify(other.range) === JSON.stringify(target.range),
      ) === i,
  );
}
