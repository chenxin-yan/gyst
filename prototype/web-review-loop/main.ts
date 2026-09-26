// PROTOTYPE, throwaway. Mounts the design; the variant switcher appears only when there is a choice.
import { h, onChange, paintAnnotations, state } from "./engine.ts";
import { variants } from "./variants.ts";

const root = document.getElementById("app")!;
let index = Math.max(
  0,
  variants.findIndex((v) => v.key === new URLSearchParams(location.search).get("variant")),
);

function go(delta: number) {
  index = (index + delta + variants.length) % variants.length;
  const url = new URL(location.href);
  url.searchParams.set("variant", variants[index]!.key);
  history.replaceState(null, "", url);
  render();
}

function render() {
  const variant = variants[index]!;
  const scroll = document.querySelector("[data-scroll]")?.scrollTop ?? 0;
  // Re-attaching the diffs drops focus, so an open composer gets it (and its caret) back.
  const typing = document.activeElement as HTMLTextAreaElement | null;
  const composer = typing?.dataset?.composer;
  const caret = composer ? [typing!.selectionStart, typing!.selectionEnd] : [];
  const switcher =
    variants.length > 1 &&
    h(
      "div",
      { class: "proto-switcher", "aria-label": "Prototype variant switcher" },
      h("button", { onclick: () => go(-1), "aria-label": "Previous variant" }, "←"),
      h("span", {}, `${variant.key} · ${variant.name}`),
      h("button", { onclick: () => go(1), "aria-label": "Next variant" }, "→"),
    );
  root.replaceChildren(variant.render(), ...(switcher ? [switcher] : []));
  paintAnnotations();
  document.querySelector("[data-scroll]")?.scrollTo({ top: scroll });
  const restored = composer && document.querySelector<HTMLTextAreaElement>(`textarea[data-composer="${CSS.escape(composer)}"]`);
  if (restored) {
    restored.focus({ preventScroll: true });
    restored.setSelectionRange(caret[0]!, caret[1]!);
  }
}

addEventListener("keydown", (event) => {
  if (variants.length < 2) return;
  const inTree = event
    .composedPath()
    .some((node) => (node as Element).tagName === "FILE-TREE-CONTAINER");
  if (state.overlay || inTree || (event.target as Element).closest?.("input, textarea")) return;
  if (event.key === "ArrowLeft") go(-1);
  if (event.key === "ArrowRight") go(1);
});

onChange(render);
render();
