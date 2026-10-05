import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { inject, onTestFinished } from "vite-plus/test";

import type { InstalledGyst } from "./global-setup.ts";

export const installed: InstalledGyst = inject("installedGyst");

/**
 * The installed CLI's environment: a private HOME and agent/XDG roots (crust's skill installer and
 * gyst's data dir resolve from these), no inherited `GYST_*` settings, and the Node under test
 * first on PATH so the bin's `#!/usr/bin/env node` selects it.
 */
export function isolatedEnv(home: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GYST_")),
  );
  return {
    ...inherited,
    PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    VIBE_HOME: join(home, ".vibe"),
    ...extra,
  };
}

export type Result = {
  readonly command: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

export function run(
  file: string,
  args: ReadonlyArray<string>,
  options: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string | undefined; timeout?: number },
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      // A hung CLI fails its own assertion with its output instead of the whole test timing out.
      timeout: options.timeout ?? 15_000,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode, signal) =>
      resolve({
        command: [file, ...args].join(" "),
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}

const describeResult = (result: Result) =>
  `${result.command} exited ${result.exitCode ?? result.signal}\n--- stdout\n${result.stdout.slice(0, 20_000)}\n--- stderr\n${result.stderr.slice(0, 20_000)}`;

const parse = (text: string, result: Result): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`expected one JSON document from ${describeResult(result)}`);
  }
};

export function succeeded(result: Result): Result {
  if (result.exitCode !== 0) throw new Error(`expected success: ${describeResult(result)}`);
  return result;
}

export const json = (result: Result): any => parse(succeeded(result).stdout, result);

export function failed(result: Result): any {
  if (result.exitCode !== 1) throw new Error(`expected exit 1: ${describeResult(result)}`);
  return parse(result.stderr, result);
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeout = 5_000,
): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!(await condition())) {
    if (performance.now() > deadline)
      throw new Error(`timed out after ${timeout} ms waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** False once the process is gone or a zombie (it holds no sockets then); Linux reads /proc for that. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  if (process.platform !== "linux") return true;
  try {
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

export const daemonPid = (dataDir: string) =>
  readFile(join(dataDir, "daemon.pid"), "utf8").then(Number, () => Number.NaN);

export const commandLine = (pid: number) =>
  spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();

/**
 * Pids of every `daemon run` process launched from the private install. E2E files run one at a
 * time and session.test.ts starts its daemons one test at a time, so there this is the current
 * test's set.
 */
export function installedDaemons(): number[] {
  const prefix = installed.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = spawnSync("pgrep", ["-f", `${prefix}.* daemon run`], { encoding: "utf8" });
  if (found.status === 1) return [];
  if (found.status !== 0) throw new Error(`pgrep failed (${found.status}): ${found.stderr}`);
  return found.stdout.trim().split("\n").map(Number);
}

export async function killDaemon(dataDir: string, signal: NodeJS.Signals = "SIGKILL") {
  const pid = await daemonPid(dataDir);
  if (Number.isNaN(pid)) throw new Error(`no daemon.pid in ${dataDir}`);
  process.kill(pid, signal);
  await waitFor(() => !isAlive(pid), `daemon ${pid} to exit after ${signal}`);
  return pid;
}

/** Sends a signal; false if the process already exited, e.g. by its own idle shutdown. */
function signal(pid: number, name: NodeJS.Signals): boolean {
  try {
    process.kill(pid, name);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

/**
 * Stops the daemon a data dir names, if it is still running from the private install; a stale
 * `daemon.pid` may name a reused pid. SIGKILLs one that ignores SIGTERM, then reports it.
 */
export async function stopDaemon(dataDir: string): Promise<void> {
  const pid = await daemonPid(dataDir);
  if (Number.isNaN(pid) || !isAlive(pid)) return;
  const args = commandLine(pid);
  if (!args.includes(installed.prefix) || !args.endsWith(" daemon run")) return;
  if (!signal(pid, "SIGTERM")) return;
  const exited = await waitFor(() => !isAlive(pid), `daemon ${pid} to exit`).then(
    () => true,
    () => false,
  );
  if (exited) return;
  signal(pid, "SIGKILL");
  await waitFor(() => !isAlive(pid), `daemon ${pid} to exit after SIGKILL`);
  throw new Error(`daemon ${pid} ignored SIGTERM during cleanup`);
}

// Cleanup must attempt every resource even if stopping one daemon fails.
export async function sandbox() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gyst-e2e-")));
  const home = join(root, "home");
  const data = join(root, "data");
  await mkdir(home);
  const env = isolatedEnv(home, { GYST_DATA_DIR: data });
  const dataDirs = new Set([data]);
  onTestFinished(async () => {
    const failures: unknown[] = [];
    for (const dataDir of dataDirs)
      await stopDaemon(dataDir).catch((error) => failures.push(error));
    await rm(root, { recursive: true, force: true }).catch((error) => failures.push(error));
    if (failures.length > 0)
      throw new AggregateError(failures, `sandbox cleanup failed: ${failures.join("; ")}`);
  });
  return {
    root,
    home,
    data,
    env,
    gyst: (cwd: string, args: ReadonlyArray<string>, stdin?: string, dataDir = data) => {
      dataDirs.add(dataDir);
      return run(installed.bin, args, { cwd, env: { ...env, GYST_DATA_DIR: dataDir }, stdin });
    },
  };
}

/** A POST to a launch's listener on loopback, with exactly the given headers. */
const post = (port: number, path: string, headers: Record<string, string>, body = "") =>
  new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const request = httpRequest(
        { host: "127.0.0.1", port, method: "POST", path, headers, setHost: false },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("error", reject);
          response.once("end", () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      request.once("error", reject);
      request.end(body);
    },
  );

/**
 * A foreground `gyst` launch signed in as its browser would be: the private URL's secret is
 * exchanged for the auth cookie, and `operation` posts a browser operation to the bridge, resolving
 * the daemon's reply. Stopped with SIGINT (Ctrl-C) after the test.
 */
export async function launchViewer(
  args: ReadonlyArray<string>,
  options: { cwd: string; env: NodeJS.ProcessEnv },
) {
  const name = ["gyst", ...args].join(" ");
  const child = spawn(installed.bin, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let exit: number | string | undefined;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.once("error", (error) => (exit ??= error.message));
  child.once("close", (code, signal) => (exit ??= code ?? signal ?? "closed"));
  const stop = async () => {
    if (exit === undefined) child.kill("SIGINT");
    await waitFor(() => exit !== undefined, `${name} to exit on SIGINT`, 10_000);
  };
  onTestFinished(stop);
  await waitFor(
    () => stdout.includes("Press Ctrl-C") || exit !== undefined,
    `${name} to be ready`,
    20_000,
  );
  // stdout is left out: it holds the secret-bearing URL.
  if (exit !== undefined) throw new Error(`${name} exited ${exit} early:\n${stderr}`);
  const url = stdout.split("\n").find((line) => line.startsWith("http://")) ?? "";
  const match = /^http:\/\/(g-[0-9a-f]{32}\.localhost):(\d+)\/session\/([^#]+)#([\w-]{43})$/.exec(
    url,
  );
  if (!match) throw new Error("the launch URL lacks the .localhost host, session path or secret");
  const [, hostname = "", port = "", id = "", secret = ""] = match;
  const host = `${hostname}:${port}`;
  const origin = `http://${host}`;
  const bootstrap = await post(Number(port), "/bootstrap", {
    host,
    origin,
    authorization: `Bearer ${secret}`,
  });
  const cookie = bootstrap.headers["set-cookie"]?.[0]?.split(";", 1)[0];
  if (bootstrap.status !== 204 || cookie === undefined)
    throw new Error(`${name} refused its own bootstrap: ${bootstrap.status}`);
  return {
    /** The session the launch opened. */
    id: decodeURIComponent(id),
    operation: async (operation: object): Promise<any> => {
      const reply = await post(
        Number(port),
        "/api/operation",
        { host, origin, cookie, "content-type": "application/json" },
        JSON.stringify(operation),
      );
      if (reply.status !== 200)
        throw new Error(`${JSON.stringify(operation)} answered ${reply.status}: ${reply.body}`);
      return JSON.parse(reply.body);
    },
    stop,
  };
}
