import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";

const FRAME_TEXT = "gyst · OpenTUI compile smoke";
const UPDATED_TEXT = "gyst · Solid signal updated";

// A signal read inside JSX only re-renders when the Solid transform compiled this file; an
// untransformed build evaluates `label()` once and never sees the update (the real TUI dies
// with "Orphan text error" in that state).
export async function renderCompileSmoke(): Promise<void> {
  const [label, setLabel] = createSignal(FRAME_TEXT);
  const renderer = await testRender(
    () => (
      <box border padding={1}>
        <text>{label()}</text>
      </box>
    ),
    { width: 40, height: 5 },
  );

  try {
    await renderer.renderOnce();
    if (!renderer.captureCharFrame().includes(FRAME_TEXT))
      throw new Error("OpenTUI smoke frame did not render");

    setLabel(UPDATED_TEXT);
    await renderer.renderOnce();
    const frame = renderer.captureCharFrame();
    if (!frame.includes(UPDATED_TEXT))
      throw new Error(
        "Solid signal update did not re-render: JSX was compiled without the Solid transform",
      );
    console.log(frame.trimEnd());
  } finally {
    renderer.renderer.destroy();
  }
}
