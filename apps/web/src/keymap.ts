// The reader's commands and the keys that run them: one typed table, read by the keyboard handler,
// the command menu and the help. Later tickets add their rows here.

import {
  DEFAULT_SEQUENCE_TIMEOUT,
  type Hotkey,
  LETTER_KEYS,
  parseHotkey,
} from "@tanstack/react-hotkeys";

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
  | "nextNote"
  | "previousNote"
  | "nextGroup"
  | "previousGroup"
  | "toggleNotes"
  | "search"
  | "nextMatch"
  | "previousMatch"
  | "open"
  | "unfold"
  | "cancel"
  | "fold"
  | "toggleFold"
  | "unfoldAll"
  | "foldAll"
  | "viewed"
  | "back"
  | "split"
  | "stacked"
  | "auto"
  | "mode"
  | "refresh"
  | "check"
  | "menu"
  | "help";

/**
 * A command, its key sequences and its label. A sequence is the keys pressed one after another, in
 * TanStack Hotkeys' names: letters match either case, so a capital is `Shift+G`. A `vimOnly`
 * command acts at the cursor, which Mouse mode has none of.
 */
export type Command = {
  id: CommandId;
  keys: readonly (readonly Hotkey[])[];
  label: string;
  vimOnly?: true;
};

export type InputMode = "vim" | "mouse";

export const commands: readonly Command[] = [
  { id: "down", keys: [["J"]], label: "Cursor down (Mouse mode: scroll down)" },
  { id: "up", keys: [["K"]], label: "Cursor up (Mouse mode: scroll up)" },
  { id: "halfDown", keys: [["Control+D"]], label: "Half a page down" },
  { id: "halfUp", keys: [["Control+U"]], label: "Half a page up" },
  { id: "top", keys: [["G", "G"]], label: "Top" },
  { id: "bottom", keys: [["Shift+G"]], label: "Bottom" },
  { id: "oldSide", keys: [["H"]], label: "Old side of a split diff", vimOnly: true },
  { id: "newSide", keys: [["L"]], label: "New side of a split diff", vimOnly: true },
  {
    id: "select",
    keys: [["Shift+V"], ["V"]],
    label: "Select lines from the cursor, or stop selecting",
    vimOnly: true,
  },
  { id: "nextChange", keys: [["]", "C"]], label: "Next change" },
  { id: "previousChange", keys: [["[", "C"]], label: "Previous change" },
  { id: "nextFile", keys: [["]", "F"]], label: "Next file" },
  { id: "previousFile", keys: [["[", "F"]], label: "Previous file" },
  { id: "nextNote", keys: [["]", "N"]], label: "Next note" },
  { id: "previousNote", keys: [["[", "N"]], label: "Previous note" },
  { id: "nextGroup", keys: [["Shift+J"]], label: "Next walkthrough group" },
  { id: "previousGroup", keys: [["Shift+K"]], label: "Previous walkthrough group" },
  { id: "toggleNotes", keys: [["I"]], label: "Show or collapse every note" },
  { id: "search", keys: [["/"]], label: "Search the current view" },
  { id: "nextMatch", keys: [["N"]], label: "Next search match" },
  { id: "previousMatch", keys: [["Shift+N"]], label: "Previous search match" },
  {
    id: "open",
    keys: [["Enter"]],
    label:
      "Open the hidden lines or the note at the cursor; on a file header, fold or unfold the file",
    vimOnly: true,
  },
  {
    id: "unfold",
    keys: [["Z", "O"]],
    label: "Open the hidden lines, the note or the folded file at the cursor",
  },
  { id: "cancel", keys: [["Escape"]], label: "Cancel the selection" },
  { id: "fold", keys: [["Z", "C"]], label: "Close the note at the cursor, or fold its file" },
  { id: "toggleFold", keys: [["Z", "A"]], label: "Toggle the note or the fold at the cursor" },
  { id: "unfoldAll", keys: [["Z", "Shift+R"]], label: "Unfold every file" },
  { id: "foldAll", keys: [["Z", "Shift+M"]], label: "Fold every file" },
  {
    id: "viewed",
    keys: [["M"]],
    label: "Mark the cursor's file Viewed and go to the next unviewed one, or unmark it",
  },
  { id: "back", keys: [["Backspace"]], label: "Back from captured code" },
  { id: "split", keys: [["1"]], label: "Split diff" },
  { id: "stacked", keys: [["2"]], label: "Stacked diff" },
  { id: "auto", keys: [["0"]], label: "Auto diff layout, by width" },
  { id: "mode", keys: [], label: "Switch between Vim and Mouse mode" },
  { id: "refresh", keys: [["Shift+R"]], label: "Refresh the session from its source" },
  { id: "check", keys: [], label: "Check the source for changes without refreshing" },
  { id: "menu", keys: [["Meta+K"], ["Control+K"]], label: "Command menu" },
  { id: "help", keys: [["?"]], label: "Keyboard shortcuts" },
];

/** The commands an input mode runs, for its keys, its menu and its help alike. */
export const commandsFor = (mode: InputMode) =>
  mode === "vim" ? commands : commands.filter((command) => !command.vimOnly);

/**
 * Whether `event` completes a sequence that `previous` started, as `R` does after `z`: it then
 * belongs to that sequence (`zR`), not to the single-key command bound to it alone (`R`).
 */
export function completesSequence(
  event: Pick<KeyboardEvent, "key">,
  previous: { readonly key: string; readonly at: number } | undefined,
  now: number,
) {
  if (previous === undefined || now - previous.at > DEFAULT_SEQUENCE_TIMEOUT) return false;
  return commands.some(({ keys }) =>
    keys.some(
      (sequence) =>
        sequence.length === 2 && typed(sequence[0]!, previous) && typed(sequence[1]!, event),
    ),
  );
}

/** Letters print as typed, Vim-style: `j`, `g g`, `Shift+g`; Backspace as `⌫`. */
export const keyLabels = {
  ...Object.fromEntries([...LETTER_KEYS].map((key) => [key, key.toLowerCase()])),
  Backspace: "⌫",
};

/**
 * Whether the event typed the character the step names. The library matches letters in either case
 * and falls back to the physical key, so Caps Lock `m` or a layout's `ь` on the M key would match `M`.
 * A Control or Meta chord still takes either case, as Caps Lock + Ctrl+D always paged.
 */
export function typed(step: Hotkey, event: Pick<KeyboardEvent, "key">) {
  const { key = "", shift, ctrl, meta } = parseHotkey(step);
  if (ctrl || meta) return event.key.toLowerCase() === key.toLowerCase();
  if ((LETTER_KEYS as ReadonlySet<string>).has(key))
    return event.key === (shift ? key : key.toLowerCase());
  return event.key === key;
}
