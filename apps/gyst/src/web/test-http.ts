// Test-only helpers: a raw HTTP/1.1 client (full control of Host, duplicates and request targets)
// and a throwaway packaged-SPA fixture. Neither ships; the real SPA arrives at dist/web-ui.
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RawResponse = {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: string;
  header(name: string): string | undefined;
};

export function send(
  port: number,
  request: {
    readonly method?: string;
    readonly target: string;
    readonly headers: ReadonlyArray<readonly [string, string]>;
    readonly body?: string;
  },
  address = "127.0.0.1",
): Promise<RawResponse> {
  const requestBody = request.body ?? "";
  const lines = [
    `${request.method ?? "GET"} ${request.target} HTTP/1.1`,
    ...request.headers.map(([name, value]) => `${name}: ${value}`),
    "connection: close",
    `content-length: ${Buffer.byteLength(requestBody)}`,
  ];
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: address });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      const [statusLine = "", ...headerLines] = text.slice(0, split).split("\r\n");
      const headers = headerLines.map((line) => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()] as const;
      });
      let body = text.slice(split + 4);
      if (headers.some(([name, value]) => name === "transfer-encoding" && value === "chunked")) {
        let chunked = body;
        body = "";
        for (;;) {
          const end = chunked.indexOf("\r\n");
          const size = Number.parseInt(chunked.slice(0, end), 16);
          if (!(size > 0)) break;
          body += chunked.slice(end + 2, end + 2 + size);
          chunked = chunked.slice(end + 4 + size);
        }
      }
      resolve({
        status: Number(statusLine.split(" ")[1]),
        headers,
        body,
        header: (name) => headers.find(([header]) => header === name)?.[1],
      });
    });
    // Not `end`: a half-closed client counts as gone, and the server abandons its response.
    socket.write(`${lines.join("\r\n")}\r\n\r\n${requestBody}`);
  });
}

export const indexHtml =
  '<!doctype html><div id="root"></div><script src="/assets/app.js"></script>';
export const secret = "outside the packaged SPA";

/** A packaged-SPA-shaped directory beside a file it must never serve, plus a symlink to that file. */
export async function webUiFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "gyst-web-")));
  const dir = join(root, "web-ui");
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "index.html"), indexHtml);
  await writeFile(join(dir, "favicon.svg"), "<svg/>");
  await writeFile(join(dir, "assets", "app.js"), "console.log(1)");
  await writeFile(join(dir, "assets", "app.css"), "body{}");
  await writeFile(join(root, "secret.txt"), secret);
  await symlink(join(root, "secret.txt"), join(dir, "assets", "link.txt"));
  return { root, dir };
}
