// For the viewer's unit tests: a raw HTTP/1.1 client (full control of Host, duplicates and request
// targets), a throwaway packaged-SPA fixture and free loopback ports.
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { type AddressInfo, connect, createServer } from "node:net";
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

export type RawStream = Omit<RawResponse, "body"> & {
  /** Each SSE event's `data` payload in arrival order, ending when the response ends or breaks. */
  frames(): AsyncGenerator<string, void>;
  /** Hangs up, as a closed tab or a stopped browser would. */
  close(): void;
};

/**
 * A streaming POST that resolves on the response head. Until `frames` is read nothing is taken off
 * the socket, so a reader that stops reading backs the server up as a stalled browser would.
 */
export function openStream(
  port: number,
  request: {
    readonly target: string;
    readonly headers: ReadonlyArray<readonly [string, string]>;
    readonly body: string;
  },
): Promise<RawStream> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: request.target,
        agent: false,
        headers: [
          ...request.headers.flat(),
          "content-length",
          String(Buffer.byteLength(request.body)),
        ],
      },
      (response) => {
        // A cut connection fails the response; `frames` reports it as the end, read or not.
        response.on("error", () => {});
        const { rawHeaders } = response;
        const headers = rawHeaders.flatMap((name, index) =>
          index % 2 === 0 ? [[name.toLowerCase(), rawHeaders[index + 1]!] as const] : [],
        );
        resolve({
          status: response.statusCode!,
          headers,
          header: (name) => headers.find(([header]) => header === name)?.[1],
          async *frames() {
            let text = "";
            try {
              for await (const chunk of response.setEncoding("utf8")) {
                text += chunk;
                for (let split = text.indexOf("\n\n"); split >= 0; split = text.indexOf("\n\n")) {
                  for (const line of text.slice(0, split).split("\n"))
                    if (line.startsWith("data: ")) yield line.slice("data: ".length);
                  text = text.slice(split + 2);
                }
              }
            } catch {}
          },
          close: () => outgoing.destroy(),
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(request.body);
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

/** A port the OS just reported free on 127.0.0.1, so a test's viewer never starts at 4978. */
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
