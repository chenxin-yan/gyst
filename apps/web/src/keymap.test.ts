import { describe, expect, it } from "vite-plus/test";
import { commands, keyLabel, keyOf, matchKey } from "./keymap.ts";

const press = (...keys: string[]) => {
  let pending: string[] = [];
  const ran: string[] = [];
  for (const key of keys) {
    const step = matchKey(pending, key);
    pending = step.pending;
    if (step.command) ran.push(step.command);
  }
  return { ran, pending };
};

describe("matchKey", () => {
  it("runs single keys and whole sequences, and waits on a prefix", () => {
    expect(press("j", "k", "G", "m", "1", "2", "0", "?")).toEqual({
      ran: ["down", "up", "bottom", "viewed", "split", "stacked", "auto", "help"],
      pending: [],
    });
    expect(press("g")).toEqual({ ran: [], pending: ["g"] });
    expect(press("g", "g").ran).toEqual(["top"]);
    expect(press("]", "c", "[", "c", "]", "f", "[", "f").ran).toEqual([
      "nextChange",
      "previousChange",
      "nextFile",
      "previousFile",
    ]);
    expect(press("z", "o", "z", "c", "z", "a", "z", "R", "z", "M").ran).toEqual([
      "unfold",
      "fold",
      "toggleFold",
      "unfoldAll",
      "foldAll",
    ]);
    expect(press("Enter", "Escape", "V", "v", "h", "l").ran).toEqual([
      "open",
      "cancel",
      "select",
      "select",
      "oldSide",
      "newSide",
    ]);
    expect(press("Ctrl-d", "Ctrl-u", "Meta-k", "Ctrl-k").ran).toEqual([
      "halfDown",
      "halfUp",
      "menu",
      "menu",
    ]);
  });

  it("starts over from a key that does not continue the sequence", () => {
    expect(press("g", "j").ran).toEqual(["down"]);
    expect(press("z", "z", "o").ran).toEqual(["unfold"]);
    expect(press("]", "x")).toEqual({ ran: [], pending: [] });
    // Keys of later tickets do nothing yet.
    expect(press("c", "r", "x", "n", "R").ran).toEqual([]);
  });

  it("has no sequence that is another's prefix or listed twice", () => {
    const sequences = commands.flatMap((command) => command.keys.map((keys) => keys.join(" ")));
    expect(new Set(sequences).size).toBe(sequences.length);
    for (const sequence of sequences)
      for (const other of sequences)
        if (other !== sequence) expect(other.startsWith(`${sequence} `)).toBe(false);
  });
});

describe("keyOf and keyLabel", () => {
  const event = (key: string, modifiers: Partial<KeyboardEvent> = {}) => ({
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...modifiers,
  });
  it("names chords and leaves Alt chords and bare modifiers out", () => {
    expect(keyOf(event("d", { ctrlKey: true }))).toBe("Ctrl-d");
    expect(keyOf(event("K", { metaKey: true }))).toBe("Meta-k");
    expect(keyOf(event("G"))).toBe("G");
    expect(keyOf(event("j", { altKey: true }))).toBeUndefined();
    expect(keyOf(event("Shift"))).toBeUndefined();
  });
  it("prints keys as the help shows them", () => {
    expect(["Ctrl-d", "Meta-k", "Enter", "Escape", "]"].map(keyLabel)).toEqual([
      "⌃d",
      "⌘K",
      "↵",
      "Esc",
      "]",
    ]);
  });
});
