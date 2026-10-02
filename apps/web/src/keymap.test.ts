import {
  areHotkeysEqual,
  formatForDisplay,
  type Hotkey,
  validateHotkey,
} from "@tanstack/react-hotkeys";
import { describe, expect, it } from "vite-plus/test";
import { commands, commandsFor, keyLabels, typed } from "./keymap.ts";

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

  // Single keys still run while a sequence is pending, so a single key that is also any step of a
  // sequence would run with it.
  it("binds no single key that is also a step of a sequence", () => {
    for (const single of singles)
      for (const sequence of sequences)
        for (const step of sequence)
          expect(areHotkeysEqual(single, step), `${single} in ${sequence.join(" ")}`).toBe(false);
  });

  it("has no keys of later tickets yet", () => {
    for (const later of ["C", "R", "X", "N", "Shift+R"] satisfies Hotkey[])
      expect(
        singles.some((single) => areHotkeysEqual(single, later)),
        later,
      ).toBe(false);
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
    ]);
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
