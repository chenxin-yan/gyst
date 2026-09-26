// Run real engines against scratch projects; no mock responses or test framework.
import assert from "node:assert/strict";
import { Lab } from "./lab.ts";
import { queryIndex } from "./engines.ts";

const lab = new Lab();
try {
  await lab.start();
  assert.deepEqual(lab.indexErrors, {}, "Both SCIP builds must succeed");
  const text = lab.new["checkout.ts"]!;
  const lines = text.split("\n");
  const line = lines.findIndex((sourceLine) => sourceLine.includes("applyDiscount(100)"));
  const position = { line, character: lines[line]!.indexOf("applyDiscount") };
  const definitions = await lab.query("new", "checkout.ts", position, "definition", false);
  for (const result of definitions.results) {
    assert.ok(!result.error, `${result.engine}: ${result.error}`);
    assert.ok(
      result.targets.some((target) => target.file === "money.ts" && target.text?.includes("* 0.8")),
      `${result.engine} must resolve imported alias to captured helper`,
    );
  }
  const aliasReferences = await lab.query("new", "checkout.ts", position, "references", false);
  const direct = { line: 1, character: lab.new["preview.js"]!.split("\n")[1]!.indexOf("discount") };
  const before = await lab.query("new", "preview.js", direct, "references", false);
  for (const result of before.results) {
    assert.ok(!result.error, `${result.engine}: ${result.error}`);
    assert.ok(
      result.targets.some((target) => target.file === "preview.js"),
      `${result.engine}: JS usage missing`,
    );
    assert.ok(
      !result.targets.some((target) => target.file === "unrelated.ts"),
      `${result.engine}: same-name unrelated symbol leaked`,
    );
  }
  const withDeclarations = await lab.query("new", "preview.js", direct, "references", true);
  for (const result of withDeclarations.results)
    assert.ok(
      result.targets.some((target) => target.file === "money.ts"),
      `${result.engine}: declaration inclusion failed`,
    );
  const crlf = await lab.query(
    "new",
    "unrelated.ts",
    { line: 2, character: lab.new["unrelated.ts"]!.split("\r\n")[2]!.indexOf("discount") },
    "definition",
    false,
  );
  for (const result of crlf.results)
    assert.ok(
      result.targets.some(
        (target) => target.file === "unrelated.ts" && target.range.start.line === 1,
      ),
      `${result.engine}: CRLF mapping failed`,
    );
  await lab.mutate();
  const changed = await lab.query("new", "checkout.ts", position, "definition", false);
  for (const result of changed.results) {
    assert.ok(!result.error, `${result.engine}: ${result.error}`);
    assert.ok(
      result.targets.some((target) =>
        target.text?.includes(result.engine === "live" ? "* 0.5" : "* 0.8"),
      ),
      `${result.engine}: revision mismatch`,
    );
  }
  const references = await lab.query("new", "preview.js", direct, "references", false);
  for (const result of references.results) {
    assert.ok(!result.error, `${result.engine}: ${result.error}`);
    assert.equal(
      result.targets.some((target) => target.file === "new-consumer.ts"),
      result.engine === "live",
      `${result.engine}: added reference must be live-only`,
    );
  }
  const old = await lab.query("old", "checkout.ts", position, "definition", false);
  for (const result of old.results.filter((entry) => entry.engine !== "live"))
    assert.ok(
      result.targets.some((target) => target.text?.includes("* 0.9")),
      `${result.engine}: old side wrong`,
    );
  const money = await lab.query("new", "money.ts", { line: 1, character: 16 }, "definition", false);
  assert.match(
    money.results[0]!.error!,
    /differs/,
    "Live query must reject unmapped changed source",
  );
  await lab.refresh();
  const refreshed = await lab.query("new", "checkout.ts", position, "definition", false);
  for (const result of refreshed.results)
    assert.ok(
      result.targets.some((target) => target.text?.includes("* 0.5")),
      `${result.engine}: refresh did not capture edit`,
    );
  const preceding = await lab.query("old", "checkout.ts", position, "definition", false);
  for (const result of preceding.results.filter((entry) => entry.engine !== "live"))
    assert.ok(
      result.targets.some((target) => target.text?.includes("* 0.8")),
      `${result.engine}: previous snapshot lost`,
    );
  await lab.stopServers();
  const offline = queryIndex(
    lab.indexes.new!,
    lab.new,
    "checkout.ts",
    position,
    "definition",
    false,
  );
  assert.ok(
    offline.some((target) => target.file === "money.ts" && target.text?.includes("* 0.5")),
    "Index navigation must work with every LSP server stopped",
  );
  console.log(
    JSON.stringify(
      {
        versions: lab.state().versions,
        initialDefinitionMs: definitions.results.map(({ engine, ms }) => ({ engine, ms })),
        aliasReferences: aliasReferences.results.map(({ engine, targets }) => ({
          engine,
          files: targets.map((target) => target.file),
        })),
        initialReferences: before.results.map(({ engine, targets, ms }) => ({
          engine,
          count: targets.length,
          ms,
        })),
        afterEditReferences: references.results.map(({ engine, targets, ms }) => ({
          engine,
          count: targets.length,
          ms,
        })),
        indexesAfterRefresh: lab.state().indexes,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: real definitions, references, aliases, JS, UTF-16, CRLF, declaration inclusion, revision isolation, live divergence, safe position refusal, refresh, index queries with LSP stopped.",
  );
} finally {
  await lab.stop();
}
