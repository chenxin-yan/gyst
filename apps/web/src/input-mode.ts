// The input mode is the one reader setting kept across reloads, in the browser's storage under one
// key. Nothing else is stored there: reading places last only for the page's life.
import type { InputMode } from "./keymap.ts";

const key = "gyst:input-mode";

/** The stored input mode; undefined when none is stored, the value is not a mode or storage fails. */
export function storedInputMode(storage?: Pick<Storage, "getItem">): InputMode | undefined {
  try {
    const value = (storage ?? localStorage).getItem(key);
    return value === "vim" || value === "mouse" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps the input mode for the next load, where the browser allows it. */
export function storeInputMode(mode: InputMode, storage?: Pick<Storage, "setItem">) {
  try {
    (storage ?? localStorage).setItem(key, mode);
  } catch {
    // A browser refusing storage (a private window, a full quota) keeps the mode for this page only.
  }
}
