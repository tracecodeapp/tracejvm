import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const port = Number(process.env.PORT ?? 8765);
const omitContentLength =
  process.env.TRACEJVM_TEST_OMIT_CONTENT_LENGTH === "1";
const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".java", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".jar", "application/java-archive"],
  [".policy", "text/plain; charset=utf-8"],
]);

createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const relative = normalize(decodeURIComponent(url.pathname))
    .replace(/^[/\\]+/, "")
    .replace(/^(\.\.(\/|\\|$))+/, "");
  let path = join(root, relative || "tests/browser/index.html");
  try {
    if (statSync(path).isDirectory()) path = join(path, "index.html");
    const size = statSync(path).size;
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end =
      range && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      start >= size
    ) {
      response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    response.writeHead(range ? 206 : 200, {
      "Content-Type": types.get(extname(path)) ?? "application/octet-stream",
      ...(!omitContentLength
        ? { "Content-Length": end - start + 1 }
        : {}),
      "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      "Cache-Control": "no-store",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "same-origin",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(path, { start, end }).pipe(response);
  } catch {
    response.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`TraceJVM compatibility host: http://127.0.0.1:${port}`);
});
