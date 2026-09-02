import { app } from "./cli/app.ts";
import { runDaemon } from "./daemon/server.ts";

const argv = process.argv.slice(2);
if (argv[0] === "daemon" && argv[1] === "run") await runDaemon();
else {
  const separator = argv[0] === "session" && argv[1] === "create" ? argv.indexOf("--") : -1;
  await app.execute({ argv: separator < 0 ? argv : argv.toSpliced(separator, 1) });
}
