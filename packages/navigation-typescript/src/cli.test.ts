import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import packageJson from "../package.json" with { type: "json" };

const cli = fileURLToPath(new URL("cli.js", import.meta.url));
const run = promisify(execFile);
const typescriptPackage = createRequire(cli).resolve("typescript/package.json");
const tscBin = join(dirname(typescriptPackage), "bin", "tsc");

const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "gyst-navigation-addon-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const exitOf = (args: ReadonlyArray<string>) =>
  run(process.execPath, [cli, ...args], { encoding: "utf8" }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: { code: number; stdout: string; stderr: string }) => error,
  );

type Message = {
  id?: number;
  method?: string;
  params?: { items?: ReadonlyArray<unknown> };
  result?: unknown;
};

/** A minimal LSP client over stdio that answers every configuration pull with defaults. */
const lsp = (child: ChildProcessWithoutNullStreams) => {
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map<number, (message: Message) => void>();
  const send = (message: object) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const message: Message = JSON.parse(buffer.subarray(start, start + length).toString("utf8"));
      buffer = buffer.subarray(start + length);
      if (message.method !== undefined && message.id !== undefined)
        send({
          id: message.id,
          result:
            message.method === "workspace/configuration"
              ? (message.params?.items ?? []).map(() => null)
              : null,
        });
      else if (message.id !== undefined) pending.get(message.id)?.(message);
    }
  });
  const request = (method: string, params: object) =>
    new Promise<Message>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      send({ id, method, params });
    });
  const notify = (method: string, params: object) => send({ method, params });
  return { request, notify };
};

const spawnEngine = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv) => {
  const child = spawn(process.execPath, args, { env, stdio: "pipe" });
  onTestFinished(() => {
    child.kill("SIGKILL");
  });
  return child;
};

/** Opens a project and asks for a definition, the work that makes the engine load it. */
const openProject = async (child: ChildProcessWithoutNullStreams, project: string) => {
  const client = lsp(child);
  const root = pathToFileURL(project).href;
  const initialized = await client.request("initialize", {
    processId: process.pid,
    rootUri: root,
    workspaceFolders: [{ uri: root, name: "project" }],
    capabilities: {
      general: { positionEncodings: ["utf-16"] },
      workspace: { configuration: true },
    },
  });
  client.notify("initialized", {});
  const uri = pathToFileURL(join(project, "index.js")).href;
  const text = await readFile(join(project, "index.js"), "utf8");
  client.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "javascript", version: 1, text },
  });
  await client.request("textDocument/definition", {
    textDocument: { uri },
    position: { line: 1, character: 0 },
  });
  return initialized;
};

/** A JS project whose declared dependencies Automatic Type Acquisition would fetch types for. */
const jsProject = async (dir: string) => {
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ name: "project", dependencies: { jquery: "3.7.1", lodash: "4.17.21" } }),
  );
  await writeFile(join(project, "index.js"), 'import $ from "jquery";\n$("body");\n');
  return project;
};

/** An `npm` that only records that it ran. */
const fakeNpm = async (dir: string) => {
  const bin = join(dir, "bin");
  const marker = join(dir, "npm-ran");
  await mkdir(bin);
  await writeFile(join(bin, "npm"), `#!/bin/sh\necho "$@" >> '${marker}'\nexit 1\n`);
  await chmod(join(bin, "npm"), 0o755);
  return { bin, marker };
};

const privateHome = async (dir: string) => {
  const home = join(dir, "home");
  await mkdir(home);
  return { HOME: home, XDG_CACHE_HOME: join(home, "cache"), TMPDIR: home };
};

const until = async (done: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  return done();
};

describe("gyst-navigation-typescript", () => {
  it("pins the exact engine it depends on", async () => {
    expect(packageJson.dependencies).toEqual({ typescript: "7.0.2" });
    expect(packageJson.dependencies.typescript).toMatch(/^\d+\.\d+\.\d+$/);
    const resolved = JSON.parse(await readFile(typescriptPackage, "utf8"));
    expect(resolved.version).toBe("7.0.2");
  });

  it("reports its own release and the engine it actually ran as one JSON line", async () => {
    const { code, stdout } = await exitOf(["--version"]);
    expect(code).toBe(0);
    expect(stdout.endsWith("\n")).toBe(true);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toEqual({
      name: "@gyst/navigation-typescript",
      version: packageJson.version,
      protocol: 1,
      engine: { ok: true, version: "7.0.2" },
    });
  });

  it("reports an engine without its native platform package instead of failing", async () => {
    // A copy outside any node_modules tree, as an install with optional dependencies omitted.
    const addon = join(await tempDir(), "addon");
    await mkdir(join(addon, "src"), { recursive: true });
    await cp(join(dirname(cli), "..", "package.json"), join(addon, "package.json"));
    await cp(cli, join(addon, "src", "cli.js"));
    await cp(dirname(typescriptPackage), join(addon, "node_modules", "typescript"), {
      recursive: true,
      dereference: true,
    });
    const { stdout } = await run(process.execPath, [join(addon, "src", "cli.js"), "--version"]);
    const handshake = JSON.parse(stdout);
    expect(handshake.version).toBe(packageJson.version);
    expect(handshake.engine.ok).toBe(false);
    expect(handshake.engine.problem).toContain(`@typescript/typescript-${process.platform}`);
  });

  it("refuses to start an engine for another release, and unknown arguments", async () => {
    const refused = await exitOf(["lsp", "--expect", "0.0.0"]);
    expect(refused).toMatchObject({ code: 2, stdout: "" });
    expect(refused.stderr).toContain(`${packageJson.version} was started by gyst 0.0.0`);
    for (const args of [[], ["lsp"], ["lsp", "--expect"], ["serve"], ["--version", "extra"]])
      expect(await exitOf(args), args.join(" ")).toMatchObject({ code: 2, stdout: "" });
  });

  it.runIf(process.platform === "linux")(
    "becomes the engine in the process gyst spawned, with no PATH",
    async () => {
      const dir = await tempDir();
      const project = await jsProject(dir);
      const env = { ...process.env, ...(await privateHome(dir)) };
      const child = spawnEngine([cli, "lsp", "--expect", packageJson.version], env);
      const initialized = await openProject(child, project);
      expect(initialized).toMatchObject({ result: { capabilities: { definitionProvider: true } } });
      const platformPackage = createRequire(typescriptPackage).resolve(
        `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
      );
      // execve replaced Node twice (add-on, then tsc.js), so the spawned PID is the engine itself.
      expect(await readlink(`/proc/${child.pid}/exe`)).toBe(
        await realpath(join(dirname(platformPackage), "lib", "tsc")),
      );
      const environ = (await readFile(`/proc/${child.pid}/environ`, "utf8")).split("\0");
      expect(environ.some((entry) => entry.startsWith("PATH="))).toBe(false);
      expect(environ).toContain(`HOME=${env.HOME}`);
    },
    30_000,
  );

  it("never runs npm from the inherited PATH, even with the engine's default settings", async () => {
    const dir = await tempDir();
    const project = await jsProject(dir);
    const npm = await fakeNpm(dir);
    const env = { ...process.env, PATH: `${npm.bin}:${process.env.PATH}` };
    // Control: the bare engine with the same PATH runs that npm for type acquisition.
    const started = Date.now();
    const bare = spawnEngine([tscBin, "--lsp", "--stdio"], { ...env, ...(await privateHome(dir)) });
    await openProject(bare, project);
    expect(await until(() => existsSync(npm.marker), 20_000)).toBe(true);
    const acquired = Date.now() - started;
    expect(await readFile(npm.marker, "utf8")).toContain("install");
    bare.kill("SIGKILL");
    await rm(npm.marker);

    const addonDir = await tempDir();
    const addon = spawnEngine([cli, "lsp", "--expect", packageJson.version], {
      ...env,
      ...(await privateHome(addonDir)),
    });
    await openProject(addon, project);
    expect(await until(() => existsSync(npm.marker), Math.max(2 * acquired, 5000))).toBe(false);
  }, 60_000);
});
