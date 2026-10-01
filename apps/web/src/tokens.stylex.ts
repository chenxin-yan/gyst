import * as stylex from "@stylexjs/stylex";

// The accepted review baseline (prototype/interactive-review): Catppuccin Mocha with lavender as the
// sole accent, Inter + JetBrains Mono. Each palette colour keeps its Catppuccin style-guide role.
// Fonts are not fetched from a font service; installed Inter/JetBrains Mono are used, otherwise the
// system faces.
export const palette = stylex.defineVars({
  red: "#f38ba8",
  peach: "#fab387",
  green: "#a6e3a1",
  blue: "#89b4fa",
  lavender: "#b4befe",
  text: "#cdd6f4",
  subtext0: "#a6adc8",
  overlay2: "#9399b2",
  overlay1: "#7f849c",
  surface0: "#313244",
  base: "#1e1e2e",
  mantle: "#181825",
  crust: "#11111b",
});

// "--" keys keep their literal custom-property names because styles.css reads them.
export const theme = stylex.defineVars({
  frame: palette.crust,
  panelBg: palette.base,
  surface: palette.mantle,
  line: palette.surface0,
  select: `color-mix(in srgb, ${palette.overlay2} 20%, transparent)`,
  ink: palette.text,
  muted: palette.subtext0,
  faint: palette.overlay1,
  "--accent": palette.lavender,
  add: palette.green,
  del: palette.red,
  changed: palette.blue,
  hunkHeader: palette.peach,
  sans: '"Inter", system-ui, sans-serif',
  "--mono": '"JetBrains Mono", ui-monospace, monospace',
});

export const media = stylex.defineConsts({ narrow: "@media (max-width: 760px)" });
