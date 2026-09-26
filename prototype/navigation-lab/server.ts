import { Lab } from "./lab.ts";

const port = Number(process.env.PORT ?? 4317);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("PORT must be 1024–65535");
const origin = `http://127.0.0.1:${port}`;
const allowedOrigins = [
  origin,
  `http://localhost:${port}`,
  ...(process.env.PUBLIC_ORIGIN ? [new URL(process.env.PUBLIC_ORIGIN).origin] : []),
];
const lab = new Lab();
let server: ReturnType<typeof Bun.serve> | undefined;
let stopping = false;
// ponytail: serialize this single-user experiment; independent sessions need separate labs, not this queue.
let queue = Promise.resolve();
console.log("Preparing isolated projects, native LSP servers and SCIP indexes…");
const ready = lab.start();
async function stop() {
  if (stopping) return;
  stopping = true;
  await server?.stop(true);
  await ready.catch(() => {});
  await queue;
  await lab.stop();
  process.exit(0);
}
process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
await ready;
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
};
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers });
}

if (!stopping)
  server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 64 * 1024,
    async fetch(request) {
      if (stopping) return json({ error: "Lab is stopping" }, 503);
      const url = new URL(request.url);
      if (
        !allowedOrigins.includes(url.origin) ||
        (request.headers.get("origin") && !allowedOrigins.includes(request.headers.get("origin")!))
      )
        return json({ error: "Unrecognized browser origin" }, 403);
      if (request.method === "GET" && url.pathname === "/")
        return new Response(Bun.file(new URL("index.html", import.meta.url)), {
          headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
        });
      if (url.pathname !== "/api/state" && request.method !== "POST")
        return json({ error: "Not found" }, 404);
      if (
        request.method === "POST" &&
        !request.headers.get("content-type")?.startsWith("application/json")
      )
        return json({ error: "Expected application/json" }, 415);
      const run = queue.then(async () => {
        if (request.method === "GET" && url.pathname === "/api/state") return json(lab.state());
        const body = (await request.json()) as Record<string, unknown>;
        if (!body || typeof body !== "object" || Array.isArray(body))
          return json({ error: "Expected object" }, 400);
        if (url.pathname === "/api/query") {
          const { side, file, line, character, kind, includeDeclaration, generation } = body;
          if (
            (side !== "old" && side !== "new") ||
            typeof file !== "string" ||
            !Object.hasOwn(lab[side], file) ||
            (kind !== "definition" && kind !== "references") ||
            typeof includeDeclaration !== "boolean"
          )
            return json({ error: "Invalid query" }, 400);
          if (generation !== lab.generation)
            return json({ error: "Snapshot changed. Reload before querying." }, 409);
          const lines = lab[side][file]!.split(/\r\n|\n|\r/);
          if (
            !Number.isInteger(line) ||
            !Number.isInteger(character) ||
            Number(line) < 0 ||
            Number(character) < 0 ||
            !lines[Number(line)] ||
            Number(character) >= lines[Number(line)]!.length
          )
            return json({ error: "Invalid source position" }, 400);
          return json(
            await lab.query(
              side,
              file,
              { line: Number(line), character: Number(character) },
              kind,
              includeDeclaration,
            ),
          );
        }
        if (url.pathname === "/api/mutate") await lab.mutate();
        else if (url.pathname === "/api/refresh") await lab.refresh();
        else if (url.pathname === "/api/reset") await lab.reset();
        else if (url.pathname === "/api/edit") {
          if (
            typeof body.file !== "string" ||
            !Object.hasOwn(lab.live, body.file) ||
            typeof body.text !== "string" ||
            body.text.length > 20000
          )
            return json({ error: "Edit an existing scratch file, at most 20,000 characters" }, 400);
          await lab.setLive({ ...lab.live, [body.file]: body.text });
        } else return json({ error: "Not found" }, 404);
        return json(lab.state());
      });
      queue = run.then(
        () => {},
        () => {},
      );
      try {
        return await run;
      } catch (error) {
        return json({ error: String(error) }, 500);
      }
    },
  });
if (!stopping) console.log(`Navigation lab ready: ${origin}`);
