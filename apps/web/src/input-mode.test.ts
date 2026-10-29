import { describe, expect, it } from "vite-plus/test";
import { storedInputMode, storeInputMode } from "./input-mode.ts";

const storage = (entries: Record<string, string> = {}) => {
  const items = new Map(Object.entries(entries));
  return {
    items,
    getItem: (name: string) => items.get(name) ?? null,
    setItem: (name: string, value: string) => void items.set(name, value),
  };
};
const refusing = {
  getItem: (): string | null => {
    throw new DOMException("denied", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
};

describe("input mode storage", () => {
  it("keeps the input mode under its one key", () => {
    const kept = storage();
    storeInputMode("mouse", kept);
    expect(Object.fromEntries(kept.items)).toEqual({ "gyst:input-mode": "mouse" });
    expect(storedInputMode(kept)).toBe("mouse");
    storeInputMode("vim", kept);
    expect(storedInputMode(kept)).toBe("vim");
  });

  it("ignores a missing or bad stored value, and storage that refuses", () => {
    expect(storedInputMode(storage())).toBeUndefined();
    for (const bad of ["emacs", "", "Mouse", '"mouse"'])
      expect(storedInputMode(storage({ "gyst:input-mode": bad }))).toBeUndefined();
    expect(storedInputMode(refusing)).toBeUndefined();
    expect(() => storeInputMode("mouse", refusing)).not.toThrow();
  });
});
