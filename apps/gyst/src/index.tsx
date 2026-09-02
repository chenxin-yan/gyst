import { app } from "./cli/app.ts";
import { runDaemon } from "./daemon/server.ts";

const argv = process.argv.slice(2);
if (argv[0] === "daemon" && argv[1] === "run") await runDaemon();
else await app.execute({ argv });
