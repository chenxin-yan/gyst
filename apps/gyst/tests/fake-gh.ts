// The `gh` that e2e tests put first on PATH, run directly by Node: it never reaches the network.
// It logs each argv to $FAKE_GH_DIR/calls.jsonl and answers `gh api graphql` with the recorded
// reply `$FAKE_GH_DIR/<pull|stack>-<owner>-<repo>-<number>.json`, and `gh repo view` with
// `$FAKE_GH_DIR/repository.json`, whatever the checkout: `{exitCode, stdout, stderr}`.
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
  const name =
    argv[0] === "repo" && argv[1] === "view"
      ? "repository.json"
      : argv[0] === "api" && argv[1] === "graphql"
        ? `${fields.get("query")?.includes("stack{") ? "stack" : "pull"}-${fields.get("owner")}-${fields.get("repo")}-${fields.get("number")}.json`
        : undefined;
  if (name === undefined) refuse(`only api graphql and repo view are recorded: ${argv}`);
  else {
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
