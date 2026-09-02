import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import {
  ApplyEnvelopeSchema,
  type DiffPayload,
  type ErrorPayload,
  ErrorPayloadSchema,
  type Reply,
  type Request,
  RequestSchema,
  type Session,
  SessionSchema,
  applyBatch,
  migratePersistedSession,
  parseSnapshot,
  refreshSession,
  statusOf,
} from "@gyst/core";
import { Schema } from "effect";

function dataDir(): string {
  return process.env.GYST_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "gyst");
}
export function socketPath(): string {
  return join(dataDir(), "daemon.sock");
}
function pidPath(): string {
  return join(dataDir(), "daemon.pid");
}
function lockPath(): string {
  return join(dataDir(), "daemon.lock");
}
const sessions = new Map<string, Session>();

function failure(code: ErrorPayload["code"], message: string, detail?: unknown): never {
  throw { code, message, ...(detail === undefined ? {} : { detail }) } satisfies ErrorPayload;
}

async function repoRoot(cwd: string): Promise<string> {
  const command = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd, stdout: "pipe", stderr: "pipe" });
  if (command.exitCode !== 0) failure("bad_args", "current directory is not inside a git repository");
  return realpath(command.stdout.toString().trim());
}

function selectedSession(id: string | undefined, root: string): Session {
  if (id) {
    const session = sessions.get(id);
    if (!session) failure("no_session", `no session with id ${id}`);
    return session;
  }
  const session = [...sessions.values()].find((candidate) => candidate.repoRoot === root);
  if (!session) failure("no_session", `no session for repository ${root}`);
  return session;
}

function defaultGitArgs(root: string): string[] {
  const head = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], { cwd: root, stdout: "ignore", stderr: "ignore" });
  if (head.exitCode === 0) return ["HEAD"];
  const emptyTree = Bun.spawnSync(["git", "hash-object", "-t", "tree", "/dev/null"], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (emptyTree.exitCode !== 0) failure("bad_args", "could not derive the empty git tree");
  return [emptyTree.stdout.toString().trim()];
}

async function gitPatch(root: string, args: readonly string[], includeUntracked: boolean): Promise<string> {
  const diff = Bun.spawnSync(["git", "diff", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (diff.exitCode !== 0) failure("bad_args", diff.stderr.toString().trim() || "git diff failed");
  let patch = diff.stdout.toString();
  if (includeUntracked) {
    const listed = Bun.spawnSync(["git", "ls-files", "--others", "--exclude-standard", "-z"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (listed.exitCode !== 0) failure("bad_args", "could not list untracked files");
    for (const file of listed.stdout.toString().split("\0").filter(Boolean)) {
      const added = Bun.spawnSync(["git", "diff", "--no-index", "--", "/dev/null", file], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (added.exitCode !== 0 && added.exitCode !== 1) failure("bad_args", added.stderr.toString().trim() || `could not diff ${file}`);
      patch += added.stdout.toString();
    }
  }
  return patch;
}

async function persist(session: Session): Promise<void> {
  const destination = join(dataDir(), `${session.id}.json`);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(session)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

function snapshot(patch: string) {
  try { return parseSnapshot(patch); }
  catch (error) { failure("bad_args", "invalid unified diff", String(error)); }
}

async function handle(request: Request): Promise<Record<string, unknown>> {
  if (request.command === "create") {
    const root = await repoRoot(request.cwd);
    const { values, positionals } = parseArgs({
      args: request.args,
      options: { stdin: { type: "boolean" } },
      allowPositionals: true,
      strict: true,
    });
    if ([...sessions.values()].some((session) => session.repoRoot === root)) {
      failure("session_exists", `a session already exists for ${root}`);
    }
    if (values.stdin && positionals.length) failure("bad_args", "--stdin cannot be combined with git arguments");
    const includeUntracked = !values.stdin && positionals.length === 0;
    const gitArgs = includeUntracked ? defaultGitArgs(root) : positionals;
    const patch = values.stdin ? (request.stdin ?? "") : await gitPatch(root, gitArgs, includeUntracked);
    const now = new Date().toISOString();
    const session: Session = {
      id: crypto.randomUUID(), repoRoot: root,
      source: values.stdin ? { kind: "stdin" } : { kind: "git", args: gitArgs, ...(includeUntracked ? { includeUntracked: true } : {}) },
      createdAt: now, updatedAt: now, revision: 0, seq: 0,
      cursor: { itemId: null, expanded: false }, hunks: snapshot(patch), groups: [], queue: [], queueSet: false, applyReceipts: [],
    };
    await persist(session);
    sessions.set(session.id, session);
    return statusOf(session);
  }

  let values: { session?: string; hunk?: string; group?: string; file?: string; stdin?: boolean };
  try {
    if (request.command === "diff") values = parseArgs({
      args: request.args,
      options: { session: { type: "string" }, hunk: { type: "string" }, group: { type: "string" }, file: { type: "string" } },
      strict: true,
    }).values;
    else if (request.command === "refresh") values = parseArgs({
      args: request.args,
      options: { session: { type: "string" }, stdin: { type: "boolean" } },
      strict: true,
    }).values;
    else values = parseArgs({ args: request.args, options: { session: { type: "string" } }, strict: true }).values;
  } catch (error) { failure("bad_args", error instanceof Error ? error.message : "invalid arguments"); }
  const root = values.session ? "" : await repoRoot(request.cwd);
  const session = selectedSession(values.session as string | undefined, root);
  if (request.command === "status") return statusOf(session);
  if (request.command === "close") {
    await rm(join(dataDir(), `${session.id}.json`), { force: true });
    sessions.delete(session.id);
    return { closed: true, sessionId: session.id };
  }
  if (request.command === "apply") {
    let envelope;
    try { envelope = Schema.decodeUnknownSync(ApplyEnvelopeSchema)(JSON.parse(request.stdin ?? "")); }
    catch (error) { failure("validation_failed", "invalid apply envelope", [{ opIndex: -1, message: String(error) }]); }
    const result = applyBatch(session, envelope);
    if (result.errorCode) failure(result.errorCode, result.errorCode === "stale_revision" ? "apply revision is stale" : "apply validation failed", result.errors);
    if (!result.session) return result.status!;
    await persist(result.session);
    sessions.set(session.id, result.session);
    return result.status!;
  }
  if (request.command === "refresh") {
    let patch: string;
    if (session.source.kind === "stdin") {
      if (!values.stdin) failure("bad_args", "stdin sessions must be refreshed with --stdin");
      patch = request.stdin ?? "";
    } else {
      if (values.stdin) failure("bad_args", "git sessions refresh their recorded arguments");
      const args = session.source.includeUntracked ? defaultGitArgs(session.repoRoot) : session.source.args;
      patch = await gitPatch(session.repoRoot, args, session.source.includeUntracked ?? false);
    }
    const refreshed = refreshSession(session, snapshot(patch));
    await persist(refreshed);
    sessions.set(session.id, refreshed);
    return statusOf(refreshed);
  }

  const selectors = [values.hunk, values.group, values.file].filter(Boolean);
  if (selectors.length > 1) failure("bad_args", "choose only one diff selector");
  let hunks = [...session.hunks];
  if (values.hunk) hunks = hunks.filter((hunk) => hunk.id === values.hunk);
  if (values.group) {
    const group = session.groups.find((candidate) => candidate.id === values.group);
    if (!group) failure("validation_failed", "group selector does not exist", { groupId: values.group });
    hunks = hunks.filter((hunk) => group.hunkIds.includes(hunk.id));
  }
  if (values.file) hunks = hunks.filter((hunk) => hunk.file === values.file);
  if ((values.hunk || values.group || values.file) && hunks.length === 0) failure("validation_failed", "diff selector matched nothing");
  return { sessionId: session.id, hunks } satisfies DiffPayload;
}

async function loadSessions(): Promise<void> {
  for (const file of await readdir(dataDir())) {
    if (!file.endsWith(".json")) continue;
    try {
      const session = Schema.decodeUnknownSync(SessionSchema)(migratePersistedSession(JSON.parse(await readFile(join(dataDir(), file), "utf8"))));
      sessions.set(session.id, session);
    } catch {
      // A corrupt or older session must not prevent the daemon serving valid sessions.
    }
  }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function acquireDaemonLock(): Promise<boolean> {
  for (;;) {
    try {
      await writeFile(lockPath(), `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(await readFile(lockPath(), "utf8").catch(() => ""));
      if (Number.isInteger(owner) && owner > 0 && processIsAlive(owner)) return false;
      await rm(lockPath(), { force: true });
    }
  }
}

function errorPayload(error: unknown): ErrorPayload {
  try { return Schema.decodeUnknownSync(ErrorPayloadSchema)(error); }
  catch { return { code: "daemon_unreachable", message: "daemon request failed", detail: String(error) }; }
}

export async function runDaemon(): Promise<void> {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  if (!await acquireDaemonLock()) return;
  try {
    await loadSessions();
    await rm(socketPath(), { force: true });
    await writeFile(pidPath(), `${process.pid}\n`, { mode: 0o600 });
    const done = Promise.withResolvers<void>();
    let requests = Promise.resolve();
    let activeRequests = 0;
    let stopping = false;
    const server = Bun.listen<{ buffer: string; decoder: TextDecoder; handled: boolean }>({
      unix: socketPath(),
      socket: {
        open(socket) { socket.data = { buffer: "", decoder: new TextDecoder(), handled: false }; },
        data(socket, bytes) {
          if (socket.data.handled) return;
          socket.data.buffer += socket.data.decoder.decode(bytes, { stream: true });
          const newline = socket.data.buffer.indexOf("\n");
          if (newline < 0) return;
          socket.data.handled = true;
          const raw = socket.data.buffer.slice(0, newline);
          activeRequests++;
          const processRequest = async () => {
            let request: Request | undefined;
            let reply: Reply;
            try {
              try { request = Schema.decodeUnknownSync(RequestSchema)(JSON.parse(raw)); }
              catch (error) { failure("bad_args", "invalid daemon request", String(error)); }
              reply = { ok: true, value: await handle(request) };
            } catch (error) {
              reply = { ok: false, error: errorPayload(error) };
            } finally {
              activeRequests--;
            }
            socket.write(`${JSON.stringify(reply)}\n`);
            socket.end();
            if (request?.command === "close") setTimeout(() => {
              if (!stopping && activeRequests === 0 && sessions.size === 0) {
                stopping = true;
                server.stop(true);
                done.resolve();
              }
            }, 20);
          };
          requests = requests.then(processRequest, processRequest);
        },
      },
    });
    await done.promise;
  } finally {
    await rm(pidPath(), { force: true });
    await rm(socketPath(), { force: true });
    await rm(lockPath(), { force: true });
  }
}
