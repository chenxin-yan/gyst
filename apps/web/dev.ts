// The viewer's dev server: `node apps/web/dev.ts [range | --session <id>]` reviews the Git
// repository of the current directory, taking the same arguments as `gyst`. `pnpm dev` and
// apps/gyst/dev/gyst run it.
import { createServer } from "vite-plus";
import { devLauncher } from "./dev-launcher.ts";

const server = await createServer({
  root: import.meta.dirname,
  configFile: `${import.meta.dirname}/vite.config.ts`,
  server: { port: 3000 },
  plugins: [devLauncher({ cwd: process.cwd(), args: process.argv.slice(2) })],
});
await server.listen();
server.bindCLIShortcuts({ print: true });
