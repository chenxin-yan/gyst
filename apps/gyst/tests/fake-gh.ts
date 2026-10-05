// The `gh` that e2e tests put first on PATH, run directly by Node: it never reaches the network.
// It logs each argv to $FAKE_GH_DIR/calls.jsonl and answers `gh api graphql` with the recorded
// reply `$FAKE_GH_DIR/<pull|stack>-<owner>-<repo>-<number>.json`: `{exitCode, stdout, stderr}`.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Reply = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };

const refuse = (message: string) => {
  process.stderr.write(`fake gh: ${message}\n`);
  process.exitCode = 1;
};

const dir = process.env.FAKE_GH_DIR;
const argv = process.argv.slice(2);
const fields = new Map<string, string>();
for (let index = 0; index < argv.length - 1; index++) {
  if (argv[index] !== "-f" && argv[index] !== "-F") continue;
  const field = argv[++index]!;
  const split = field.indexOf("=");
  fields.set(field.slice(0, split), field.slice(split + 1));
}

if (dir === undefined) refuse("FAKE_GH_DIR is not set");
else {
  appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify({ argv })}\n`);
  if (argv[0] !== "api" || argv[1] !== "graphql") refuse(`only api graphql is recorded: ${argv}`);
  else {
    const kind = fields.get("query")?.includes("stack{") ? "stack" : "pull";
    const name = `${kind}-${fields.get("owner")}-${fields.get("repo")}-${fields.get("number")}.json`;
    let reply: Reply | undefined;
    try {
      reply = JSON.parse(readFileSync(join(dir, name), "utf8")) as Reply;
    } catch {
      refuse(`no fixture ${name}`);
    }
    if (reply) {
      process.stdout.write(reply.stdout);
      process.stderr.write(reply.stderr);
      process.exitCode = reply.exitCode;
    }
  }
}
