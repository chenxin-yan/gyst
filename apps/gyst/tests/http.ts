// For the viewer's unit tests: a raw HTTP/1.1 client (full control of Host, duplicates and request
// targets), a throwaway packaged-SPA fixture and free loopback ports.
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { type IncomingMessage, request as httpRequest } from "node:http";
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
  /** Each WebSocket text message in arrival order, ending when the server closes or it breaks. */
  frames(): AsyncGenerator<string, void>;
  /** Hangs up, as a closed tab or a stopped browser would. */
  close(): void;
};

/**
 * A WebSocket handshake that resolves on the response head: 101 and its messages, or a refusal and
 * none. Until `frames` is read nothing is taken off the socket, so a reader that stops reading
 * backs the server up as a stalled browser would.
 */
export function openStream(
  port: number,
  request: { readonly target: string; readonly headers: ReadonlyArray<readonly [string, string]> },
): Promise<RawStream> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      host: "127.0.0.1",
      port,
      path: request.target,
      agent: false,
      headers: [
        ...request.headers.flat(),
        "connection",
        "upgrade",
        "upgrade",
        "websocket",
        "sec-websocket-version",
        "13",
        "sec-websocket-key",
        randomBytes(16).toString("base64"),
      ],
    });
    const head = (response: IncomingMessage) => {
      const { rawHeaders } = response;
      const headers = rawHeaders.flatMap((name, index) =>
        index % 2 === 0 ? [[name.toLowerCase(), rawHeaders[index + 1]!] as const] : [],
      );
      return {
        status: response.statusCode!,
        headers,
        header: (name: string) => headers.find(([header]) => header === name)?.[1],
      };
    };
    outgoing.once("response", (response) => {
      response.resume();
      resolve({ ...head(response), async *frames() {}, close: () => outgoing.destroy() });
    });
    outgoing.once("upgrade", (response, socket, first) => {
      // A cut connection ends the messages, read or not.
      socket.on("error", () => {});
      resolve({
        ...head(response),
        // Unfragmented, unmasked server messages: what the daemon sends.
        async *frames() {
          let bytes = first;
          const chunks = socket[Symbol.asyncIterator]();
          const need = async (count: number) => {
            while (bytes.length < count) {
              const chunk = await chunks.next();
              if (chunk.done) return false;
              bytes = Buffer.concat([bytes, chunk.value]);
            }
            return true;
          };
          try {
            for (;;) {
              if (!(await need(2))) return;
              const opcode = bytes[0]! & 0x0f;
              let length = bytes[1]! & 0x7f;
              let offset = 2;
              if (length === 126) {
                if (!(await need(4))) return;
                length = bytes.readUInt16BE(2);
                offset = 4;
              }
              if (!(await need(offset + length))) return;
              const payload = bytes.subarray(offset, offset + length);
              bytes = bytes.subarray(offset + length);
              if (opcode === 0x8) return;
              if (opcode === 0x1) yield payload.toString("utf8");
            }
          } catch {
          } finally {
            socket.destroy();
          }
        },
        close: () => socket.destroy(),
      });
    });
    outgoing.on("error", reject);
    outgoing.end();
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
