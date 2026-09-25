// PROTOTYPE, throwaway. Mounts the variant named by ?variant= and the floating switcher.
import { h, onChange, state } from "./engine.ts";
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
  document.body.dataset.variant = variant.key;
  root.replaceChildren(
    variant.render(),
    h(
      "div",
      { class: "proto-switcher", "aria-label": "Prototype variant switcher" },
      h("button", { onclick: () => go(-1), "aria-label": "Previous variant" }, "←"),
      h("span", {}, `${variant.key} · ${variant.name}`),
      h("button", { onclick: () => go(1), "aria-label": "Next variant" }, "→"),
    ),
  );
  document.querySelector("[data-scroll]")?.scrollTo({ top: scroll });
}

addEventListener("keydown", (event) => {
  const inTree = event.composedPath().some((node) => (node as Element).tagName === "FILE-TREE-CONTAINER");
  if (state.overlay || inTree || (event.target as HTMLElement).closest("input")) return;
  if (event.key === "ArrowLeft") go(-1);
  if (event.key === "ArrowRight") go(1);
});

onChange(render);
render();
