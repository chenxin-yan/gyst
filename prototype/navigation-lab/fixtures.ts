// Throwaway inputs: no user checkout is analyzed or modified.
export const common = {
  "barrel.ts": 'export { discount as applyDiscount } from "./money";\n',
  "checkout.ts": [
    'import { applyDiscount } from "./barrel";',
    "",
    "// An astral character before the identifier exercises UTF-16 columns.",
    'const compass = "🧭"; export const total = applyDiscount(100);',
    "export const secondTotal = applyDiscount(200);",
    "",
  ].join("\n"),
  "preview.js": [
    'import { discount } from "./money";',
    "export const preview = discount(50);",
    "",
  ].join("\n"),
  "unrelated.ts": [
    "// Same spelling, different symbol: should not appear as a money.ts usage.",
    "export function discount(label: string) { return label.toUpperCase(); }",
    'export const badge = discount("sale");',
    "",
  ].join("\r\n"),
};

export const originalOld = {
  ...common,
  "money.ts":
    "// Before the change: ten percent off.\nexport function discount(amount: number) {\n  return amount * 0.9;\n}\n",
};
export const originalNew = {
  ...common,
  "money.ts":
    "// Reviewed change: twenty percent off.\nexport function discount(amount: number) {\n  return amount * 0.8;\n}\n",
};
export const editedLive = {
  ...originalNew,
  "money.ts":
    "// The agent changed this AFTER capture.\n// Definition moved; behavior changed.\n\nexport function discount(amount: number) {\n  return amount * 0.5;\n}\n",
  "new-consumer.ts":
    'import { discount } from "./money";\nexport const agentAdded = discount(300);\n',
};

export type Files = Record<string, string>;
export type Side = "old" | "new";
export type Position = { line: number; character: number };
export type Range = { start: Position; end: Position };
export type Target = { file: string; range: Range; text?: string; unavailable?: string };
