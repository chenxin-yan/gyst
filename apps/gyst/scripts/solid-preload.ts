// Bun standalone executables (the crust CLI, gyst itself) also run this cwd preload; only real Bun can load the Solid transform.
if (!Bun.main.startsWith("/$bunfs/")) await import("@opentui/solid/preload");
