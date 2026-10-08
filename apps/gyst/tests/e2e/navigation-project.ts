// The TS/JS project navigation tests query, through the daemon's operations or in a browser, and
// the helpers that build and address it.
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { write } from "./installed-gyst.ts";

export const oldMath =
  "export function add(first: number, second: number) {\n  return first + second;\n}\n";
export const newMath = `// Arithmetic helpers.\nexport const zero = 0;\n${oldMath}`;
export const oldUse =
  'import { add as plus } from "./math.js";\nexport const three = plus(1, 2);\n';
export const newUse =
  'import { add as plus, zero } from "./math.js";\n' +
  "export const three = plus(1, 2) + zero;\n" +
  "export const four = plus(three, 1);\n";
export const crlf = 'export const 𐐀name = "𐐀";\r\nexport const twice = 𐐀name + 𐐀name;\r\n';
export const packageJson =
  '{ "name": "fixture", "type": "module", "dependencies": { "left-pad": "1.3.0" } }\n';
/** The TS fixture: `add` moves down two lines in the new side, and `plus` aliases it. */
export const mathFiles = {
  committed: {
    "package.json": packageJson,
    "README.md": "# fixture\n",
    "src/math.ts": oldMath,
    "src/use.ts": oldUse,
  },
  edited: { "src/math.ts": newMath, "src/use.ts": newUse, "src/crlf.ts": crlf },
};

/** A repository at `cwd` with `committed` as its only commit and `edited` left uncommitted. */
export async function gitProject(
  env: NodeJS.ProcessEnv,
  cwd: string,
  committed: Record<string, string>,
  edited: Record<string, string>,
) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "ignore" });
  await mkdir(cwd);
  git("init", "-q");
  git("config", "user.email", "test@gyst.invalid");
  git("config", "user.name", "Gyst Test");
  await write(cwd, committed);
  git("add", ".");
  git("commit", "-qm", "initial");
  await write(cwd, edited);
  return cwd;
}

/** The range of the `nth` `word` on a 1-based LF-delimited line. */
export const span = (text: string, line: number, word: string, nth = 0) => {
  const lineText = text.split("\n")[line - 1]!;
  let character = -1;
  for (let index = 0; index <= nth; index++) character = lineText.indexOf(word, character + 1);
  if (character === -1) throw new Error(`no ${word} on line ${line}`);
  return { start: { line, character }, end: { line, character: character + word.length } };
};
export const at = (text: string, line: number, word: string, nth = 0) =>
  span(text, line, word, nth).start;
