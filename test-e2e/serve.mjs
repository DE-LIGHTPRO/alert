// Static server for the end-to-end run. Serves web/ with no-store.
//
// no-store matters more than it looks. During development a plain `python3 -m
// http.server` sends no Cache-Control, the browser cached a module heuristically, and an
// edit appeared to do nothing: `performance.getEntriesByType("resource")` reported
// `deliveryType: "cache"` and `transferSize: 0` while the fix sat correct on disk. A test
// run that silently exercises yesterday's bundle is worse than no test run.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const ROOT = join(import.meta.dirname, "..", "web");
const PORT = Number(process.env.PORT || 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".eml": "message/rfc822",
  ".svg": "image/svg+xml",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    // Reject traversal rather than clamping it, so a bad path is loud in a test.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (rel.includes("..")) {
      res.writeHead(400).end("bad path");
      return;
    }
    const path = join(ROOT, rel === "/" ? "index.html" : rel);
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": TYPES[extname(path)] || "application/octet-stream",
      "cache-control": "no-store, must-revalidate",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`serving web/ on http://127.0.0.1:${PORT}`);
});
