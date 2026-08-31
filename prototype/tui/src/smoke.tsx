// Headless smoke check: renders the hybrid layout, drives the a/e/u/tab grammar,
// asserts the frame at each step. `bun run smoke`.
import assert from "node:assert";
import { testRender } from "@opentui/solid";
import { App } from "./main";

const t = await testRender(() => <App />, { width: 100, height: 30 });
await t.renderOnce();

let frame = t.captureCharFrame();
assert(frame.includes("GROUPS"), "sidebar renders");
assert(frame.includes("rename getUser → fetchUser"), "first group focused");
assert(frame.includes("exemplar · 1 of 8"), "folded card shows exemplar");
assert(frame.includes("item 1/6"), "header shows queue position");

// e: expand toggle (peek, not a verdict)
await t.mockInput.pressKey("e");
await t.renderOnce();
frame = t.captureCharFrame();
assert(frame.includes("all 8 members"), "expand shows all members");
await t.mockInput.pressKey("e");
await t.renderOnce();
assert(t.captureCharFrame().includes("exemplar · 1 of 8"), "expand folds back");

// a: accept → auto-advance
await t.mockInput.pressKey("a");
await t.renderOnce();
frame = t.captureCharFrame();
assert(frame.includes("item 2/6"), "accept auto-advances");
assert(frame.includes("1/6 done"), "progress counts the verdict");
assert(frame.includes("import path"), "next group focused");

// u: undo returns to the undone item
await t.mockInput.pressKey("u");
await t.renderOnce();
frame = t.captureCharFrame();
assert(frame.includes("item 1/6"), "undo returns cursor");
assert(frame.includes("0/6 done"), "undo clears the verdict");

// tab: sidebar collapses
await t.mockInput.pressKey("TAB");
await t.renderOnce();
assert(!t.captureCharFrame().includes("GROUPS"), "tab hides sidebar");
await t.mockInput.pressKey("TAB");
await t.renderOnce();

// accept everything → done card
for (let i = 0; i < 6; i++) {
  await t.mockInput.pressKey("a");
  await t.renderOnce();
}
frame = t.captureCharFrame();
assert(frame.includes("review complete"), "done card shows");
assert(frame.includes("6/6 accepted"), "all verdicts counted");

console.log("smoke OK — layout, expand toggle, accept→advance, undo, sidebar, done card");
process.exit(0);
