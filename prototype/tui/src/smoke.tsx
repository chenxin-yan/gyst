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

// a: accept marks the item and stays put
await t.mockInput.pressKey("a");
await t.renderOnce();
frame = t.captureCharFrame();
assert(frame.includes("item 1/6"), "accept stays put");
assert(frame.includes("1/6 done"), "progress counts the verdict");
assert(frame.includes("✓ accepted"), "card shows the verdict");

// a again: toggle off
await t.mockInput.pressKey("a");
await t.renderOnce();
assert(t.captureCharFrame().includes("0/6 done"), "toggle-off clears the verdict");

// u: undo jumps back to the last accepted item
await t.mockInput.pressKey("a");
await t.renderOnce();
await t.mockInput.pressKey("j");
await t.renderOnce();
await t.mockInput.pressKey("u");
await t.renderOnce();
frame = t.captureCharFrame();
assert(frame.includes("item 1/6"), "undo returns cursor");
assert(frame.includes("0/6 done"), "undo clears the verdict");

// layout modes: width 100 → auto resolves stack; '1' forces split (pairing puts -/+ on one row)
assert(t.captureCharFrame().includes("auto·stack"), "auto resolves stack at width 100");
const onOneRow = (f: string) =>
  f.split("\n").some((ln) => ln.includes("= getUser(") && ln.includes("= fetchUser("));
assert(!onOneRow(t.captureCharFrame()), "stack keeps -/+ on separate rows");
await t.mockInput.pressKey("1");
await t.renderOnce();
frame = t.captureCharFrame();
assert(frame.includes(" split "), "header shows forced split");
assert(onOneRow(frame), "split pairs deletion and addition on one row");
await t.mockInput.pressKey("0");
await t.renderOnce();
t.resize(140, 30);
await t.renderOnce();
assert(t.captureCharFrame().includes("auto·split"), "auto resolves split at width 140");
t.resize(100, 30);
await t.renderOnce();
assert(t.captureCharFrame().includes("auto·stack"), "auto falls back to stack when narrow");

// s: sidebar collapses
await t.mockInput.pressKey("s");
await t.renderOnce();
assert(!t.captureCharFrame().includes("GROUPS"), "s hides sidebar");
await t.mockInput.pressKey("s");
await t.renderOnce();

// ?: help overlay opens, blocks keys, esc closes
await t.mockInput.pressKey("?");
await t.renderOnce();
assert(t.captureCharFrame().includes("undo last accept"), "? opens help overlay");
await t.mockInput.pressKey("j");
await t.renderOnce();
frame = t.captureCharFrame();
assert(frame.includes("undo last accept"), "keys are inert while help is up");
assert(frame.includes("item 1/6"), "cursor did not move under the overlay");
// lone ESC is ambiguous for the key parser in headless tests; q is an equivalent close key
await t.mockInput.pressKey("q");
await t.renderOnce();
assert(!t.captureCharFrame().includes("undo last accept"), "q closes help");

// accept everything → done card
for (let i = 0; i < 6; i++) {
  await t.mockInput.pressKey("a");
  await t.renderOnce();
  await t.mockInput.pressKey("j");
  await t.renderOnce();
}
frame = t.captureCharFrame();
assert(frame.includes("review complete"), "done card shows");
assert(frame.includes("6/6 accepted"), "all verdicts counted");

console.log("smoke OK — layout modes, expand, accept toggle, undo, sidebar, help overlay, done card");
process.exit(0);
