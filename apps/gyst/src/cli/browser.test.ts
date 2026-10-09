import { describe, expect, it } from "vite-plus/test";
import { browserOpener } from "./browser.ts";

describe("browserOpener", () => {
  it("opens only for an interactive local desktop, else the operator gets the link", () => {
    expect(browserOpener("darwin", {}, true)).toBe("open");
    expect(browserOpener("linux", { DISPLAY: ":0" }, true)).toBe("xdg-open");
    expect(browserOpener("linux", { WAYLAND_DISPLAY: "wayland-0" }, true)).toBe("xdg-open");
    expect(browserOpener("linux", {}, true)).toBeUndefined();
    expect(browserOpener("linux", { DISPLAY: ":0" }, false)).toBeUndefined();
    expect(browserOpener("darwin", { SSH_CONNECTION: "1 2 3 4" }, true)).toBeUndefined();
    expect(browserOpener("linux", { DISPLAY: ":10", SSH_TTY: "/dev/pts/1" }, true)).toBeUndefined();
    expect(browserOpener("win32", {}, true)).toBeUndefined();
  });
});
