// Process helpers for tests of the globally installed package prepared by global-setup.ts.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

/** Asserts a zero exit, reporting the full invocation otherwise. */
export function succeeded(result: Result): Result {
  if (result.exitCode !== 0) throw new Error(`expected success: ${describeResult(result)}`);
  return result;
}

/** The JSON reply of a successful command. */
export const json = (result: Result): any => parse(succeeded(result).stdout, result);

/** The JSON error line of a command that exited 1. */
export function failed(result: Result): any {
  if (result.exitCode !== 1) throw new Error(`expected exit 1: ${describeResult(result)}`);
  return parse(result.stderr, result);
}

/** Polls a definitive condition, failing with its description instead of retrying indefinitely. */
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

/** The command line the OS reports for a process, for asserting what a daemon was launched from. */
export const commandLine = (pid: number) =>
  spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();

/**
 * Pids of every `daemon run` process launched from the private install. Only session.test.ts starts
 * daemons, one test at a time, so this is the current test's set.
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
async function stopDaemon(dataDir: string): Promise<void> {
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

/**
 * A private root with its own HOME and default data dir; `gyst` runs the installed bin there.
 * After the test, daemons named by any data dir it used are stopped and the root is removed; every
 * step runs even if an earlier one failed, and all failures are reported.
 */
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
