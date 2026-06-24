// csb-db — serves carsearchbuddy.sqlite3 from R2 for sql.js-httpvfs.
// Adds HTTP range support, CORS, and edge caching of each byte-range chunk so
// repeat reads come from the Cloudflare CDN instead of round-tripping to R2.
// (The Cache API rejects 206 responses, so each chunk is stored as a 200 keyed
//  by its byte range and re-wrapped as a 206 on the way out.)

const KEY = "carsearchbuddy.sqlite3";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
  "Access-Control-Allow-Headers": "Range,If-None-Match",
  "Access-Control-Expose-Headers": "Content-Length,Content-Range,Accept-Ranges,ETag",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response("Method Not Allowed", { status: 405, headers: CORS });

    const rangeHeader = request.headers.get("Range");

    // HEAD, or a GET with no Range: return metadata (and the full body for a bare GET).
    if (request.method === "HEAD" || !rangeHeader) {
      const head = await env.DB_BUCKET.head(KEY);
      if (!head) return new Response("Not found", { status: 404, headers: CORS });
      const h = new Headers(CORS);
      h.set("Accept-Ranges", "bytes");
      h.set("Content-Type", "application/octet-stream");
      h.set("ETag", head.httpEtag);
      h.set("Content-Length", String(head.size));
      if (request.method === "HEAD") return new Response(null, { status: 200, headers: h });
      const obj = await env.DB_BUCKET.get(KEY);
      h.set("Cache-Control", "public,max-age=31536000,immutable");
      return new Response(obj.body, { status: 200, headers: h });
    }

    const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
    if (!m) return new Response("Range Not Satisfiable", { status: 416, headers: CORS });
    const offset = parseInt(m[1], 10);
    const endReq = m[2] ? parseInt(m[2], 10) : null;

    // Edge cache keyed by the exact byte range. Stored as a 200 (Cache API won't
    // store 206s); the total object size rides along in X-Total.
    const cache = caches.default;
    const ck = new Request(`https://csb-db.cache/${KEY}?o=${offset}&e=${endReq ?? ""}`);
    const hit = await cache.match(ck);
    if (hit) {
      const total = hit.headers.get("X-Total");
      const buf = await hit.arrayBuffer();
      return new Response(buf, { status: 206, headers: rangeHeaders(offset, buf.byteLength, total) });
    }

    const range = endReq != null ? { offset, length: endReq - offset + 1 } : { offset };
    const obj = await env.DB_BUCKET.get(KEY, { range });
    if (!obj) return new Response("Not found", { status: 404, headers: CORS });
    const total = obj.size;
    const buf = await obj.arrayBuffer();

    const stored = new Response(buf, {
      status: 200,
      headers: {
        "X-Total": String(total),
        "Content-Type": "application/octet-stream",
        "Cache-Control": "public,max-age=31536000,immutable",
      },
    });
    ctx.waitUntil(cache.put(ck, stored));

    return new Response(buf, { status: 206, headers: rangeHeaders(offset, buf.byteLength, total) });
  },
};

function rangeHeaders(offset, length, total) {
  const h = new Headers(CORS);
  h.set("Accept-Ranges", "bytes");
  h.set("Content-Type", "application/octet-stream");
  h.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${total}`);
  h.set("Content-Length", String(length));
  h.set("Cache-Control", "public,max-age=31536000,immutable");
  return h;
}
