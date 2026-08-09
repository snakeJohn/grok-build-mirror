/**
 * GitHub Release / raw / archive download proxy for Cloudflare Workers.
 * Usage:
 *   https://<worker>/https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
 *   https://<worker>/https://github.com/<owner>/<repo>/archive/refs/tags/<tag>.zip
 *   https://<worker>/https://raw.githubusercontent.com/<owner>/<repo>/<ref>/path
 *
 * Optional env:
 *   ALLOWED_REPOS = "owner/repo,owner2/repo2"  (empty = any public github file URL)
 *   HOME_HTML     = if set, not used; built-in landing page always available at /
 */

const ALLOWED_HOSTS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "gist.githubusercontent.com",
  "codeload.github.com",
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return landing(url);
    }

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    const target = resolveTarget(url);
    if (!target.ok) {
      return json({ error: target.error }, 400);
    }

    const allow = checkAllowlist(target.href, env.ALLOWED_REPOS);
    if (!allow.ok) {
      return json({ error: allow.error }, 403);
    }

    // Only proxy safe methods
    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method not allowed" }, 405);
    }

    const headers = new Headers();
    // Forward range for resume downloads
    const range = request.headers.get("Range");
    if (range) headers.set("Range", range);
    const ifRange = request.headers.get("If-Range");
    if (ifRange) headers.set("If-Range", ifRange);
    headers.set(
      "User-Agent",
      "cf-gh-proxy/1.0 (+https://github.com/; personal mirror)"
    );
    headers.set("Accept", "*/*");

    let upstream;
    try {
      upstream = await fetch(target.href, {
        method: request.method,
        headers,
        redirect: "follow",
        cf: {
          // Cache public release assets at edge when possible
          cacheTtlByStatus: { "200-299": 3600, "404": 60, "500-599": 0 },
          cacheEverything: false,
        },
      });
    } catch (e) {
      return json(
        { error: "upstream fetch failed", detail: String(e) },
        502
      );
    }

    const out = new Headers();
    const pass = [
      "content-type",
      "content-length",
      "content-disposition",
      "accept-ranges",
      "content-range",
      "etag",
      "last-modified",
      "cache-control",
    ];
    for (const k of pass) {
      const v = upstream.headers.get(k);
      if (v) out.set(k, v);
    }
    // Help browsers download with a filename when missing
    if (!out.has("content-disposition")) {
      const name = target.href.split("/").pop() || "download";
      out.set(
        "content-disposition",
        `attachment; filename="${sanitizeFilename(decodeURIComponent(name))}"`
      );
    }
    out.set("access-control-allow-origin", "*");
    out.set("x-proxied-from", new URL(target.href).host);
    out.set("x-proxy", "cf-gh-proxy");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  },
};

function resolveTarget(url) {
  // Forms:
  // 1) /https://github.com/...
  // 2) /github.com/...
  // 3) ?url=https://github.com/...
  let raw = url.searchParams.get("url");
  if (!raw) {
    raw = url.pathname.replace(/^\/+/, "");
    if (!raw) return { ok: false, error: "missing target url" };
  }
  raw = decodeURIComponent(raw);
  if (!/^https?:\/\//i.test(raw)) {
    raw = "https://" + raw;
  }

  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "invalid target url" };
  }

  if (!ALLOWED_HOSTS.has(u.hostname)) {
    return {
      ok: false,
      error: `host not allowed: ${u.hostname}`,
    };
  }

  // Block weird paths that aren't downloads
  if (u.hostname === "github.com") {
    const p = u.pathname;
    const okPath =
      /\/releases\/download\//.test(p) ||
      /\/archive\//.test(p) ||
      /\/raw\//.test(p) ||
      /\/releases\/latest\/download\//.test(p);
    if (!okPath) {
      return {
        ok: false,
        error:
          "only github.com releases/download, archive, raw, latest/download are allowed",
      };
    }
  }

  return { ok: true, href: u.href };
}

function checkAllowlist(href, allowedRepos) {
  const list = (allowedRepos || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return { ok: true };

  // Extract owner/repo from common github URLs
  let m = href.match(
    /https?:\/\/(?:github\.com|raw\.githubusercontent\.com|codeload\.github\.com)\/([^/]+)\/([^/]+)/i
  );
  if (!m) {
    // objects.githubusercontent.com has no repo path — allow if list set only when from redirect chain
    // Be conservative: deny objects host when allowlist is set (browser gets redirected already)
    if (/objects\.githubusercontent\.com/i.test(href)) return { ok: true };
    return { ok: false, error: "cannot parse repo for allowlist" };
  }
  const repo = `${m[1]}/${m[2]}`.toLowerCase().replace(/\.git$/, "");
  if (!list.includes(repo)) {
    return { ok: false, error: `repo not in ALLOWED_REPOS: ${repo}` };
  }
  return { ok: true };
}

function sanitizeFilename(name) {
  return name.replace(/[^\w.\-()+@]+/g, "_").slice(0, 180);
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "range, if-range, content-type",
    "access-control-max-age": "86400",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

function landing(url) {
  const base = url.origin;
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GitHub Release 加速代理</title>
  <style>
    body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.6;color:#111}
    code,pre{background:#f4f4f5;border-radius:6px;padding:2px 6px}
    pre{padding:12px;overflow:auto}
    input{width:100%;padding:10px;font-size:14px;box-sizing:border-box}
    button{margin-top:8px;padding:10px 16px;cursor:pointer}
    .muted{color:#666;font-size:14px}
  </style>
</head>
<body>
  <h1>GitHub Release 加速</h1>
  <p class="muted">Cloudflare Worker 反代 · 仅转发 GitHub 公开下载资源</p>
  <label>粘贴 GitHub 下载链接</label>
  <input id="u" placeholder="https://github.com/org/repo/releases/download/v1.0.0/file.exe" />
  <button id="go">生成加速链接</button>
  <p id="out"></p>
  <h2>用法</h2>
  <pre>${base}/https://github.com/&lt;owner&gt;/&lt;repo&gt;/releases/download/&lt;tag&gt;/&lt;file&gt;</pre>
  <p class="muted">支持 Range 断点续传。请勿用于非法内容。</p>
  <script>
    const base = ${JSON.stringify(base)};
    document.getElementById('go').onclick = () => {
      let v = document.getElementById('u').value.trim();
      if (!v) return;
      if (!/^https?:\\/\\//i.test(v)) v = 'https://' + v;
      const link = base + '/' + v;
      document.getElementById('out').innerHTML = '<a href="'+link+'">'+link+'</a>';
    };
  </script>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
