import { areHotkeysEqual, formatForDisplay, validateHotkey } from "@tanstack/react-hotkeys";
import { describe, expect, it } from "vite-plus/test";
import { commands, commandsFor, completesSequence, keyLabels, typed } from "./keymap.ts";

const bindings = commands.flatMap((command) => command.keys.map((keys) => ({ ...command, keys })));
const singles = bindings.filter(({ keys }) => keys.length === 1).map(({ keys }) => keys[0]!);
const sequences = bindings.filter(({ keys }) => keys.length > 1).map(({ keys }) => keys);
const keysOf = (id: string) => commands.find((command) => command.id === id)!.keys;

describe("commands", () => {
  it("names every key as TanStack Hotkeys knows it", () => {
    for (const { keys } of bindings)
      for (const key of keys)
        expect(validateHotkey(key), key).toMatchObject({ valid: true, warnings: [] });
  });

  it("binds no key sequence twice", () => {
    for (const [at, { keys }] of bindings.entries())
      for (const other of bindings.slice(at + 1))
        expect(
          other.keys.length === keys.length &&
            keys.every((key, step) => areHotkeysEqual(key, other.keys[step]!)),
          `${keys.join(" ")} / ${other.keys.join(" ")}`,
        ).toBe(false);
  });

  // Single keys still run while a sequence is pending, so a single key that is also a step of a
  // sequence would run with it, unless it ends a two-key sequence just started: `R` refreshes, but
  // `z` then `R` unfolds every file instead.
  it("binds no single key that is also a step of a sequence, except one ending a sequence just begun", () => {
    for (const single of singles)
      for (const sequence of sequences)
        for (const [step, key] of sequence.entries())
          expect(
            areHotkeysEqual(single, key) && !(sequence.length === 2 && step === 1),
            `${single} in ${sequence.join(" ")}`,
          ).toBe(false);
    expect(keysOf("refresh")).toEqual([["Shift+R"]]);
    expect(completesSequence({ key: "R" }, { key: "z", at: 1000 }, 1500)).toBe(true);
    expect(completesSequence({ key: "R" }, { key: "z", at: 1000 }, 2500)).toBe(false);
    expect(completesSequence({ key: "R" }, { key: "j", at: 1000 }, 1500)).toBe(false);
    expect(completesSequence({ key: "R" }, undefined, 1500)).toBe(false);
    expect(completesSequence({ key: "m" }, { key: "z", at: 1000 }, 1500)).toBe(false);
  });

  // c comments and r replies, while ]c, zc and zR keep their sequences; C lists every comment.
  it("binds conversation keys beside the sequences they end", () => {
    const label = (id: string) =>
      keysOf(id).map((keys) =>
        keys.map((key) => formatForDisplay(key, { platform: "linux", keyLabels })).join(" "),
      );
    expect(
      ["comment", "reply", "resolve", "comments", "nextThread", "previousThread"].map(label),
    ).toEqual([["c"], ["r"], ["x"], ["Shift+c"], ["] t"], ["[ t"]]);
    expect(completesSequence({ key: "c" }, { key: "]", at: 1000 }, 1500)).toBe(true);
    expect(completesSequence({ key: "c" }, { key: "z", at: 1000 }, 1500)).toBe(true);
    expect(completesSequence({ key: "c" }, { key: "j", at: 1000 }, 1500)).toBe(false);
    // r after g is gr's, never a reply.
    expect(completesSequence({ key: "r" }, { key: "g", at: 1000 }, 1500)).toBe(true);
    expect(completesSequence({ key: "r" }, { key: "j", at: 1000 }, 1500)).toBe(false);
    expect(typed("C", { key: "C" })).toBe(false);
    expect(typed("Shift+C", { key: "C" })).toBe(true);
    expect(typed("R", { key: "R" })).toBe(false);
    // Mouse mode comments on its selection, and replies or resolves in the open thread.
    expect(commandsFor("mouse").map(({ id }) => id)).toEqual(
      expect.arrayContaining(["comment", "reply", "resolve", "comments", "nextThread"]),
    );
  });

  it("prints keys for the help and the menu as the platform shows them", () => {
    const label = (id: string, platform: "mac" | "linux") =>
      keysOf(id).map((keys) =>
        keys.map((key) => formatForDisplay(key, { platform, keyLabels })).join(" "),
      );
    expect(
      ["down", "halfDown", "bottom", "unfoldAll", "menu", "open", "cancel", "help"].map((id) =>
        label(id, "linux"),
      ),
    ).toEqual([
      ["j"],
      ["Ctrl+d"],
      ["Shift+g"],
      ["z Shift+r"],
      ["Super+k", "Ctrl+k"],
      ["↵"],
      ["Esc"],
      ["?"],
    ]);
    expect(["halfDown", "bottom", "menu", "top"].map((id) => label(id, "mac"))).toEqual([
      ["⌃ d"],
      ["⇧ g"],
      ["⌘ k", "⌃ k"],
      ["g g"],
    ]);
  });

  // Shift+J walks groups while j moves the cursor; ]n and [n walk notes, and i shows them all.
  it("binds walkthrough groups and notes apart from movement", () => {
    const label = (id: string) =>
      keysOf(id).map((keys) =>
        keys.map((key) => formatForDisplay(key, { platform: "linux", keyLabels })).join(" "),
      );
    expect(
      ["nextGroup", "previousGroup", "nextNote", "previousNote", "toggleNotes"].map(label),
    ).toEqual([["Shift+j"], ["Shift+k"], ["] n"], ["[ n"], ["i"]]);
    expect(areHotkeysEqual("Shift+J", "J")).toBe(false);
    expect(typed("Shift+J", { key: "J" })).toBe(true);
    expect(typed("J", { key: "J" })).toBe(false);
    expect(typed("Shift+J", { key: "j" })).toBe(false);
    expect(commandsFor("mouse").map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "nextGroup",
        "previousGroup",
        "nextNote",
        "previousNote",
        "toggleNotes",
      ]),
    );
  });

  // Back leaves captured code in either input mode.
  it("binds Back to Backspace, printed as ⌫", () => {
    for (const platform of ["linux", "mac"] as const)
      expect(
        keysOf("back").map((keys) =>
          keys.map((key) => formatForDisplay(key, { platform, keyLabels })).join(" "),
        ),
      ).toEqual(["⌫"]);
    expect(commandsFor("mouse").map(({ id }) => id)).toContain("back");
  });

  // Mouse mode has no cursor: a command that acts at it is neither bound, listed nor offered there.
  it("leaves cursor-only commands, such as Open, to Vim mode", () => {
    const ids = (mode: "vim" | "mouse") => commandsFor(mode).map(({ id }) => id);
    expect(ids("vim")).toEqual(commands.map(({ id }) => id));
    expect(commandsFor("vim").find(({ id }) => id === "open")?.keys).toEqual([["Enter"]]);
    expect(commands.filter(({ id }) => !ids("mouse").includes(id)).map(({ id }) => id)).toEqual([
      "oldSide",
      "newSide",
      "select",
      "open",
      "definition",
      "references",
    ]);
  });

  // `/` searches the current view in either mode; n and N step through its matches, while ]n and
  // [n keep walking notes.
  it("binds search and its matches apart from notes, in both modes", () => {
    const label = (id: string) =>
      keysOf(id).map((keys) =>
        keys.map((key) => formatForDisplay(key, { platform: "linux", keyLabels })).join(" "),
      );
    expect(["search", "nextMatch", "previousMatch"].map(label)).toEqual([
      ["/"],
      ["n"],
      ["Shift+n"],
    ]);
    expect(commandsFor("mouse").map(({ id }) => id)).toEqual(
      expect.arrayContaining(["search", "nextMatch", "previousMatch"]),
    );
    expect(areHotkeysEqual("/", "?")).toBe(false);
    expect(typed("/", { key: "?" })).toBe(false);
    expect(typed("N", { key: "n" })).toBe(true);
    expect(typed("Shift+N", { key: "N" })).toBe(true);
  });

  it("gives n to a note sequence ] or [ just began, and N to search", () => {
    expect(completesSequence({ key: "n" }, { key: "]", at: 1000 }, 1500)).toBe(true);
    expect(completesSequence({ key: "n" }, { key: "[", at: 1000 }, 1500)).toBe(true);
    expect(completesSequence({ key: "N" }, { key: "]", at: 1000 }, 1500)).toBe(false);
    expect(completesSequence({ key: "n" }, { key: "j", at: 1000 }, 1500)).toBe(false);
    expect(completesSequence({ key: "n" }, { key: "]", at: 1000 }, 2500)).toBe(false);
  });

  // gd and gr ask from the cursor's line; after g, a capital R still refreshes and r ends gr.
  it("binds gd and gr for definitions and usages beside gg", () => {
    const label = (id: string) =>
      keysOf(id).map((keys) =>
        keys.map((key) => formatForDisplay(key, { platform: "linux", keyLabels })).join(" "),
      );
    expect(["definition", "references", "top"].map(label)).toEqual([["g d"], ["g r"], ["g g"]]);
    expect(completesSequence({ key: "r" }, { key: "g", at: 1000 }, 1500)).toBe(true);
    expect(completesSequence({ key: "R" }, { key: "g", at: 1000 }, 1500)).toBe(false);
  });

  // A standalone walkthrough reads: navigation, folds, layouts, peeks and Back, never a write.
  it("leaves only reading commands to a standalone walkthrough", () => {
    const writes = [
      "comment",
      "reply",
      "resolve",
      "comments",
      "nextThread",
      "previousThread",
      "viewed",
      "refresh",
      "check",
      "export",
    ];
    for (const mode of ["vim", "mouse"] as const) {
      const ids = commandsFor(mode, true).map(({ id }) => id);
      expect(ids).toEqual(
        commandsFor(mode)
          .map(({ id }) => id)
          .filter((id) => !writes.includes(id)),
      );
      expect(ids).toEqual(
        expect.arrayContaining(["nextFile", "nextGroup", "nextNote", "unfoldAll", "back", "split"]),
      );
    }
    expect(commandsFor("vim", false).map(({ id }) => id)).toContain("export");
  });

  // Caps Lock types `M` without Shift, and another layout types `ь` on the M key.
  it("runs a key only for the character its binding names", () => {
    const event = (key: string, init: Partial<KeyboardEvent> = {}) => ({ ...init, key });
    expect(typed("M", event("m", { code: "KeyM" }))).toBe(true);
    expect(typed("M", event("M", { code: "KeyM" }))).toBe(false);
    expect(typed("Shift+M", event("M", { code: "KeyM", shiftKey: true }))).toBe(true);
    expect(typed("Control+D", event("d", { code: "KeyD", ctrlKey: true }))).toBe(true);
    expect(typed("Control+D", event("D", { code: "KeyD", ctrlKey: true }))).toBe(true);
    expect(typed("?", event("?", { code: "Slash", shiftKey: true }))).toBe(true);
    expect(typed("M", event("ь", { code: "KeyM" }))).toBe(false);
  });
});
