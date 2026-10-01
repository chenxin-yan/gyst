// The reader's commands and the keys that run them: one typed table, read by the keyboard handler,
// the command menu and the help. Later tickets add their rows here.

export type CommandId =
  | "down"
  | "up"
  | "halfDown"
  | "halfUp"
  | "top"
  | "bottom"
  | "oldSide"
  | "newSide"
  | "select"
  | "nextChange"
  | "previousChange"
  | "nextFile"
  | "previousFile"
  | "open"
  | "unfold"
  | "cancel"
  | "fold"
  | "toggleFold"
  | "unfoldAll"
  | "foldAll"
  | "viewed"
  | "split"
  | "stacked"
  | "auto"
  | "mode"
  | "menu"
  | "help";

/**
 * A command, its key sequences and its label. A sequence is the keys pressed one after another,
 * each written as `keyOf` names it.
 */
export type Command = { id: CommandId; keys: readonly (readonly string[])[]; label: string };

export const commands: readonly Command[] = [
  { id: "down", keys: [["j"]], label: "Cursor down (Mouse mode: scroll down)" },
  { id: "up", keys: [["k"]], label: "Cursor up (Mouse mode: scroll up)" },
  { id: "halfDown", keys: [["Ctrl-d"]], label: "Half a page down" },
  { id: "halfUp", keys: [["Ctrl-u"]], label: "Half a page up" },
  { id: "top", keys: [["g", "g"]], label: "Top" },
  { id: "bottom", keys: [["G"]], label: "Bottom" },
  { id: "oldSide", keys: [["h"]], label: "Old side of a split diff" },
  { id: "newSide", keys: [["l"]], label: "New side of a split diff" },
  { id: "select", keys: [["V"], ["v"]], label: "Select lines from the cursor, or stop selecting" },
  { id: "nextChange", keys: [["]", "c"]], label: "Next change" },
  { id: "previousChange", keys: [["[", "c"]], label: "Previous change" },
  { id: "nextFile", keys: [["]", "f"]], label: "Next file" },
  { id: "previousFile", keys: [["[", "f"]], label: "Previous file" },
  {
    id: "open",
    keys: [["Enter"]],
    label: "Open the hidden lines at the cursor; on a file header, fold or unfold the file",
  },
  {
    id: "unfold",
    keys: [["z", "o"]],
    label: "Open the hidden lines or the folded file at the cursor",
  },
  { id: "cancel", keys: [["Escape"]], label: "Cancel the selection" },
  { id: "fold", keys: [["z", "c"]], label: "Fold the cursor's file" },
  { id: "toggleFold", keys: [["z", "a"]], label: "Toggle the fold at the cursor" },
  { id: "unfoldAll", keys: [["z", "R"]], label: "Unfold every file" },
  { id: "foldAll", keys: [["z", "M"]], label: "Fold every file" },
  {
    id: "viewed",
    keys: [["m"]],
    label: "Mark the cursor's file Viewed and go to the next unviewed one, or unmark it",
  },
  { id: "split", keys: [["1"]], label: "Split diff" },
  { id: "stacked", keys: [["2"]], label: "Stacked diff" },
  { id: "auto", keys: [["0"]], label: "Auto diff layout, by width" },
  { id: "mode", keys: [], label: "Switch between Vim and Mouse mode" },
  { id: "menu", keys: [["Meta-k"], ["Ctrl-k"]], label: "Command menu" },
  { id: "help", keys: [["?"]], label: "Keyboard shortcuts" },
];

/**
 * A keydown's name in the table: Ctrl and Meta prefix the lowercase key (`Ctrl-d`, `Meta-k`);
 * Shift is already in the key itself (`G`, `?`). Undefined for keys the table never uses alone:
 * Alt chords and bare modifiers.
 */
export function keyOf(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">) {
  if (event.altKey || ["Control", "Meta", "Shift", "Alt"].includes(event.key)) return undefined;
  if (event.ctrlKey) return `Ctrl-${event.key.toLowerCase()}`;
  if (event.metaKey) return `Meta-${event.key.toLowerCase()}`;
  return event.key;
}

const startsWith = (sequence: readonly string[], prefix: readonly string[]) =>
  prefix.length <= sequence.length && prefix.every((key, index) => sequence[index] === key);

/**
 * Feeds one key to a pending sequence. A whole sequence runs its command; a prefix of one waits
 * for more; anything else starts over from this key alone, so `g j` still moves down.
 */
export function matchKey(
  pending: readonly string[],
  key: string,
): { command?: CommandId; pending: string[] } {
  for (const keys of pending.length > 0 ? [[...pending, key], [key]] : [[key]]) {
    const whole = commands.find((command) =>
      command.keys.some(
        (sequence) => sequence.length === keys.length && startsWith(sequence, keys),
      ),
    );
    if (whole) return { command: whole.id, pending: [] };
    if (commands.some((command) => command.keys.some((sequence) => startsWith(sequence, keys))))
      return { pending: keys };
  }
  return { pending: [] };
}

const keyNames: Record<string, string> = { Enter: "↵", Escape: "Esc" };

/** How the help and the menu print a key: `⌃d`, `⌘K`, `↵`, `Esc`. */
export const keyLabel = (key: string) =>
  key.startsWith("Ctrl-")
    ? `⌃${key.slice(5)}`
    : key.startsWith("Meta-")
      ? `⌘${key.slice(5).toUpperCase()}`
      : (keyNames[key] ?? key);
