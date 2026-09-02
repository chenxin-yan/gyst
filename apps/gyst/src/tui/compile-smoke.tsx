import { testRender } from "@opentui/solid";

const FRAME_TEXT = "gyst · OpenTUI compile smoke";

export async function renderCompileSmoke(): Promise<void> {
  const renderer = await testRender(
    () => (
      <box border padding={1}>
        <text>{FRAME_TEXT}</text>
      </box>
    ),
    { width: 40, height: 5 },
  );

  await renderer.renderOnce();
  const frame = renderer.captureCharFrame();
  if (!frame.includes(FRAME_TEXT)) throw new Error("OpenTUI smoke frame did not render");
  console.log(frame.trimEnd());
}
