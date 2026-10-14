// A visit counter with sessions, kept in Valkey.
//
//   GET /         counts the visit (all visitors, and this browser's session)
//   GET /healthz  200 once Valkey answers PING, 503 until then
//
// Settings (environment variables):
//   REDIS_URL  the cache's connection string, e.g. rediss://default:<password>@<host>:6379
//   CA_DIR     where the cache's CA certificate is found (default /etc/computesphere/db);
//              every *.crt file in it is trusted. Read again on every connection attempt,
//              because it can appear a little after the app starts.
//   PORT       the port to listen on (default 3000)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createClient } = require("redis");

const PORT = Number(process.env.PORT || 3000);
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const CA_DIR = process.env.CA_DIR || "/etc/computesphere/db";
const SESSION_TTL = 30 * 60; // seconds

let client = null;

function readCAs() {
  try {
    return fs
      .readdirSync(CA_DIR)
      .filter((f) => f.endsWith(".crt"))
      .map((f) => fs.readFileSync(path.join(CA_DIR, f), "utf8"));
  } catch {
    return [];
  }
}

async function connect() {
  const tls = REDIS_URL.startsWith("rediss://");
  for (;;) {
    const ca = tls ? readCAs() : [];
    if (tls && ca.length === 0) {
      console.log(`waiting for a CA certificate in ${CA_DIR}`);
      await sleep(5000);
      continue;
    }
    // Until the first connection, a failure ends the attempt (so the next one
    // reads the CA again); after it, the client reconnects by itself.
    let up = false;
    const c = createClient({
      url: REDIS_URL,
      disableOfflineQueue: true, // while disconnected, fail at once (503) rather than wait
      socket: {
        ...(tls ? { tls: true, ca } : {}),
        reconnectStrategy: (n, err) => (up ? Math.min(n * 200, 5000) : err),
      },
    });
    c.on("error", (err) => console.error("valkey:", err.message));
    try {
      await c.connect();
      await c.ping();
      up = true;
      console.log("connected to valkey");
      client = c;
      return;
    } catch (err) {
      console.error("valkey connect failed:", err.message);
      if (c.isOpen) await c.disconnect().catch(() => {});
      await sleep(5000);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sessionId(req, res) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{32})/.exec(req.headers.cookie || "");
  if (m) return m[1];
  const sid = crypto.randomBytes(16).toString("hex");
  res.setHeader("Set-Cookie", `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL}`);
  return sid;
}

function page(total, mine) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visit counter</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #0f172a; }
  .n { font-size: 3rem; font-weight: 700; margin: 0; }
  p { color: #475569; }
</style></head>
<body>
  <h1>Visit counter</h1>
  <p class="n">${total}</p>
  <p>visits in total, counted in Valkey.</p>
  <p>This browser has visited <strong>${mine}</strong> ${mine === 1 ? "time" : "times"} this session. Sessions end after 30 minutes without a visit.</p>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/healthz") {
    let ok = false;
    try {
      ok = client !== null && client.isReady && (await client.ping()) === "PONG";
    } catch {}
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok }));
  }
  if (url.pathname !== "/") {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found\n");
  }
  if (!client || !client.isReady) {
    res.writeHead(503, { "content-type": "text/plain", "retry-after": "5" });
    return res.end("connecting to valkey, try again in a few seconds\n");
  }
  try {
    const sid = sessionId(req, res);
    const key = `session:${sid}`;
    const [total, mine] = await client.multi().incr("visits:total").hIncrBy(key, "visits", 1).expire(key, SESSION_TTL).exec();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(page(total, mine));
  } catch (err) {
    console.error("request failed:", err.message);
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("valkey is unavailable\n");
  }
});

server.listen(PORT, () => console.log(`listening on ${PORT}`));
connect();

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close();
    if (client) client.quit().catch(() => {});
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
