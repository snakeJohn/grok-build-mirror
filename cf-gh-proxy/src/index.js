/**
 * dl — short GitHub Release download proxy + gated mirror portal
 * Worker name: dl  →  https://dl.<subdomain>.workers.dev
 */

const ALLOWED_HOSTS = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "gist.githubusercontent.com",
  "codeload.github.com",
]);

const COOKIE = "dl_gate";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 14; // 14 days

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Auth endpoints
    if (url.pathname === "/auth" && request.method === "POST") {
      return handleAuth(request, env);
    }
    if (url.pathname === "/logout") {
      return redirectWithClearCookie(url.origin + "/");
    }

    // Health (no auth — ops only, no secrets)
    if (url.pathname === "/health") {
      return json({ ok: true, service: "dl" });
    }

    // API: releases for mirror repo (requires gate)
    if (url.pathname === "/api/releases") {
      if (!isAuthed(request, env)) return json({ error: "unauthorized" }, 401);
      return handleReleasesApi(env);
    }

    // Landing / gate UI
    if (url.pathname === "/" || url.pathname === "") {
      if (!isAuthed(request, env)) {
        return html(renderGatePage(url, env, false));
      }
      return html(await renderPortalPage(url, env));
    }

    // Proxy path
    if (!isAuthed(request, env)) {
      // Allow code via query for one-shot download links
      const q = url.searchParams.get("code") || url.searchParams.get("k");
      if (!q || !timingSafeEqual(String(q), String(env.ACCESS_CODE || ""))) {
        if (wantsHtml(request)) {
          return html(renderGatePage(url, env, true), 401);
        }
        return json({ error: "access code required", hint: "login at / or append ?code=" }, 401);
      }
    }

    const target = resolveTarget(url);
    if (!target.ok) return json({ error: target.error }, 400);

    const allow = checkAllowlist(target.href, env.ALLOWED_REPOS);
    if (!allow.ok) return json({ error: allow.error }, 403);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return json({ error: "method not allowed" }, 405);
    }

    return proxyGithub(request, target.href);
  },
};

// ─── Auth ───────────────────────────────────────────────────────────────────

function isAuthed(request, env) {
  const code = env.ACCESS_CODE;
  if (!code) return false;
  const cookie = parseCookie(request.headers.get("Cookie") || "");
  const token = cookie[COOKIE];
  if (!token) {
    // header / query one-shot already handled for proxy; for pages only cookie
    const h = request.headers.get("X-Access-Code");
    if (h && timingSafeEqual(h, code)) return true;
    return false;
  }
  return timingSafeEqual(token, gateToken(code));
}

async function handleAuth(request, env) {
  const code = env.ACCESS_CODE || "";
  let submitted = "";
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const body = await request.json().catch(() => ({}));
    submitted = String(body.code || "");
  } else {
    const form = await request.formData().catch(() => null);
    if (form) submitted = String(form.get("code") || "");
  }

  if (!code || !timingSafeEqual(submitted, code)) {
    const url = new URL(request.url);
    if (wantsHtml(request) || ct.includes("form")) {
      return html(renderGatePage(url, env, false, "访问码不正确"), 401);
    }
    return json({ error: "invalid access code" }, 401);
  }

  const headers = new Headers({
    Location: new URL("/", request.url).toString(),
    "Set-Cookie": serializeCookie(COOKIE, gateToken(code), {
      maxAge: COOKIE_MAX_AGE,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
    }),
  });
  return new Response(null, { status: 303, headers });
}

function redirectWithClearCookie(location) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      "Set-Cookie": serializeCookie(COOKIE, "", { maxAge: 0, path: "/", httpOnly: true, secure: true, sameSite: "Lax" }),
    },
  });
}

function gateToken(code) {
  // Lightweight opaque cookie value (not crypto MAC — Worker secret is the code itself)
  return "v1." + b64url(code);
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ba = enc.encode(String(a));
  const bb = enc.encode(String(b));
  if (ba.length !== bb.length) {
    // still walk to reduce trivial timing leaks on length
    let x = 0;
    for (let i = 0; i < ba.length; i++) x |= ba[i];
    return false;
  }
  let out = 0;
  for (let i = 0; i < ba.length; i++) out |= ba[i] ^ bb[i];
  return out === 0;
}

// ─── Proxy ──────────────────────────────────────────────────────────────────

async function proxyGithub(request, href) {
  const headers = new Headers();
  const range = request.headers.get("Range");
  if (range) headers.set("Range", range);
  const ifRange = request.headers.get("If-Range");
  if (ifRange) headers.set("If-Range", ifRange);
  headers.set("User-Agent", "dl-proxy/2.0 (+mirror)");
  headers.set("Accept", "*/*");

  let upstream;
  try {
    upstream = await fetch(href, {
      method: request.method,
      headers,
      redirect: "follow",
    });
  } catch (e) {
    return json({ error: "upstream fetch failed", detail: String(e) }, 502);
  }

  const out = new Headers();
  for (const k of [
    "content-type",
    "content-length",
    "content-disposition",
    "accept-ranges",
    "content-range",
    "etag",
    "last-modified",
    "cache-control",
  ]) {
    const v = upstream.headers.get(k);
    if (v) out.set(k, v);
  }
  if (!out.has("content-disposition")) {
    const name = href.split("/").pop() || "download";
    out.set(
      "content-disposition",
      `attachment; filename="${sanitizeFilename(decodeURIComponent(name))}"`
    );
  }
  out.set("access-control-allow-origin", "*");
  out.set("x-proxied-from", new URL(href).host);
  out.set("x-proxy", "dl");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

function resolveTarget(url) {
  let raw = url.searchParams.get("url");
  if (!raw) {
    raw = url.pathname.replace(/^\/+/, "");
    // strip optional leading proxy noise
    if (!raw) return { ok: false, error: "missing target url" };
  }
  // drop trailing query already on pathname-encoded forms
  raw = decodeURIComponent(raw);
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;

  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "invalid target url" };
  }
  if (!ALLOWED_HOSTS.has(u.hostname)) {
    return { ok: false, error: `host not allowed: ${u.hostname}` };
  }
  if (u.hostname === "github.com") {
    const p = u.pathname;
    const ok =
      /\/releases\/download\//.test(p) ||
      /\/archive\//.test(p) ||
      /\/raw\//.test(p) ||
      /\/releases\/latest\/download\//.test(p);
    if (!ok) {
      return {
        ok: false,
        error: "only releases/download, archive, raw, latest/download allowed",
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
  if (!list.length) return { ok: true };
  const m = href.match(
    /https?:\/\/(?:github\.com|raw\.githubusercontent\.com|codeload\.github\.com)\/([^/]+)\/([^/]+)/i
  );
  if (!m) {
    if (/objects\.githubusercontent\.com/i.test(href)) return { ok: true };
    return { ok: false, error: "cannot parse repo for allowlist" };
  }
  const repo = `${m[1]}/${m[2]}`.toLowerCase().replace(/\.git$/, "");
  if (!list.includes(repo)) return { ok: false, error: `repo not allowed: ${repo}` };
  return { ok: true };
}

// ─── Releases API ───────────────────────────────────────────────────────────

async function handleReleasesApi(env) {
  const repo = (env.MIRROR_REPO || "snakeJohn/grok-build-mirror").trim();
  const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=8`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "dl-mirror-portal",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!r.ok) {
    return json({ error: "github api failed", status: r.status }, 502);
  }
  const data = await r.json();
  const slim = (data || []).map((rel) => ({
    tag: rel.tag_name,
    name: rel.name,
    draft: rel.draft,
    prerelease: rel.prerelease,
    published_at: rel.published_at,
    html_url: rel.html_url,
    body: rel.body,
    assets: (rel.assets || []).map((a) => ({
      name: a.name,
      size: a.size,
      download_count: a.download_count,
      content_type: a.content_type,
      browser_download_url: a.browser_download_url,
    })),
  }));
  return json({ repo, releases: slim });
}

// ─── Pages ──────────────────────────────────────────────────────────────────

function renderGatePage(url, env, fromProxy, errorMsg) {
  const title = env.SITE_TITLE || "DL";
  const err = errorMsg
    ? `<p class="err" role="alert">${escapeHtml(errorMsg)}</p>`
    : fromProxy
      ? `<p class="err" role="alert">下载需要访问码，请先验证</p>`
      : "";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)} · Access</title>
${sharedHead()}
</head>
<body class="gate-body">
  <div class="noise" aria-hidden="true"></div>
  <div class="orb orb-a" aria-hidden="true"></div>
  <div class="orb orb-b" aria-hidden="true"></div>
  <main class="gate">
    <header class="gate-brand reveal">
      <div class="mark" aria-hidden="true">
        ${icon("zap", 22)}
      </div>
      <div>
        <p class="eyebrow">Private mirror · edge proxy</p>
        <h1 class="gate-title">${escapeHtml(title)}</h1>
      </div>
    </header>
    <form class="gate-card reveal d1" method="post" action="/auth" autocomplete="off">
      <label class="lbl" for="code">访问码</label>
      <div class="field">
        <span class="field-ico" aria-hidden="true">${icon("key-round", 18)}</span>
        <input id="code" name="code" type="password" inputmode="text" required
          placeholder="输入访问码" autofocus spellcheck="false"/>
      </div>
      ${err}
      <button type="submit" class="btn btn-primary btn-block">
        <span>进入镜像站</span>
        ${icon("arrow-right", 18)}
      </button>
      <p class="hint">会话约 14 天有效 · 仅授权访问 GitHub Release 加速</p>
    </form>
    <footer class="gate-foot reveal d2">
      <span class="mono">dl · cloudflare workers</span>
    </footer>
  </main>
</body>
</html>`;
}

async function renderPortalPage(url, env) {
  const repo = (env.MIRROR_REPO || "snakeJohn/grok-build-mirror").trim();
  const title = env.SITE_TITLE || "DL";
  const origin = url.origin;

  let releases = [];
  let loadError = "";
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=6`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "dl-mirror-portal",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (r.ok) {
      const data = await r.json();
      releases = data || [];
    } else {
      loadError = `GitHub API ${r.status}`;
    }
  } catch (e) {
    loadError = String(e);
  }

  const latest = releases[0];
  const assetsHtml = latest
    ? renderAssets(latest, origin)
    : `<p class="muted">暂无 Release${loadError ? " · " + escapeHtml(loadError) : ""}</p>`;

  const historyHtml = releases
    .slice(0, 5)
    .map((rel, i) => {
      const n = (rel.assets || []).length;
      const when = rel.published_at
        ? new Date(rel.published_at).toISOString().slice(0, 10)
        : "—";
      return `<a class="hist-row reveal d${Math.min(i + 1, 4)}" href="${escapeHtml(rel.html_url)}" target="_blank" rel="noopener">
        <span class="hist-tag mono">${escapeHtml(rel.tag_name)}</span>
        <span class="hist-name">${escapeHtml(rel.name || rel.tag_name)}</span>
        <span class="hist-meta muted">${when} · ${n} assets</span>
        ${icon("external-link", 16)}
      </a>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${escapeHtml(title)} · ${escapeHtml(repo)}</title>
${sharedHead()}
</head>
<body>
  <div class="noise" aria-hidden="true"></div>
  <div class="orb orb-a" aria-hidden="true"></div>
  <div class="orb orb-b" aria-hidden="true"></div>
  <div class="grid-bg" aria-hidden="true"></div>

  <header class="top">
    <div class="top-inner">
      <a class="brand" href="/">
        <span class="mark sm">${icon("zap", 18)}</span>
        <span class="brand-text">${escapeHtml(title)}</span>
      </a>
      <nav class="nav">
        <a href="#mirror">镜像</a>
        <a href="#proxy">加速</a>
        <a href="https://github.com/${escapeHtml(repo)}" target="_blank" rel="noopener">仓库 ${icon("external-link", 14)}</a>
        <a class="nav-out" href="/logout">${icon("log-out", 16)} 退出</a>
      </nav>
    </div>
  </header>

  <main>
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow reveal">Unofficial mirror · edge accelerated</p>
        <h1 class="display reveal d1">
          <span class="line">Grok Build</span>
          <span class="line accent-line">CLI Mirror</span>
        </h1>
        <p class="lede reveal d2">
          从官方公开产物同步至 GitHub Release，经 Cloudflare 边缘加速下载。
          非官方镜像，仅便于访问；登录与模型调用仍走 xAI。
        </p>
        <div class="hero-actions reveal d3">
          <a class="btn btn-primary" href="#mirror">
            ${icon("download", 18)}
            <span>获取最新包</span>
          </a>
          <a class="btn btn-ghost" href="https://github.com/${escapeHtml(repo)}" target="_blank" rel="noopener">
            ${icon("github", 18)}
            <span>${escapeHtml(repo)}</span>
          </a>
        </div>
      </div>
      <aside class="hero-panel reveal d2" aria-label="仓库状态">
        <div class="panel-glow" aria-hidden="true"></div>
        <div class="panel-head">
          <span class="dot"></span>
          <span class="mono">live · ${escapeHtml(repo)}</span>
        </div>
        <div class="stat-grid">
          <div class="stat">
            <span class="stat-l">Latest</span>
            <span class="stat-v mono">${escapeHtml(latest?.tag_name || "—")}</span>
          </div>
          <div class="stat">
            <span class="stat-l">Assets</span>
            <span class="stat-v mono">${latest ? (latest.assets || []).length : 0}</span>
          </div>
          <div class="stat">
            <span class="stat-l">Published</span>
            <span class="stat-v mono">${latest?.published_at ? new Date(latest.published_at).toISOString().slice(0, 10) : "—"}</span>
          </div>
          <div class="stat">
            <span class="stat-l">Edge</span>
            <span class="stat-v mono">CF Workers</span>
          </div>
        </div>
        <p class="panel-note muted">自动任务每 6 小时检查官方 stable 频道</p>
      </aside>
    </section>

    <section id="mirror" class="section">
      <div class="section-head">
        <h2 class="h2 reveal">最新 Release</h2>
        <p class="muted reveal d1">点击即走加速链路 · 已通过访问门控</p>
      </div>
      <div class="release-card reveal d1">
        <div class="release-top">
          <div>
            <p class="eyebrow">${escapeHtml(latest?.name || "Grok Build")}</p>
            <h3 class="h3 mono">${escapeHtml(latest?.tag_name || "—")}</h3>
          </div>
          ${
            latest
              ? `<a class="btn btn-ghost sm" href="${escapeHtml(latest.html_url)}" target="_blank" rel="noopener">${icon("tag", 16)} GitHub</a>`
              : ""
          }
        </div>
        <div class="asset-list">
          ${assetsHtml}
        </div>
      </div>
    </section>

    <section class="section">
      <div class="section-head">
        <h2 class="h2 reveal">版本历史</h2>
      </div>
      <div class="hist">
        ${historyHtml || `<p class="muted">暂无历史版本</p>`}
      </div>
    </section>

    <section id="proxy" class="section">
      <div class="section-head">
        <h2 class="h2 reveal">链接加速</h2>
        <p class="muted reveal d1">粘贴本仓库或白名单内的 GitHub 下载地址</p>
      </div>
      <div class="proxy-card reveal d1">
        <label class="lbl" for="src">GitHub 原始链接</label>
        <div class="field">
          <span class="field-ico">${icon("link", 18)}</span>
          <input id="src" type="url" placeholder="https://github.com/${escapeHtml(repo)}/releases/download/..."/>
        </div>
        <div class="proxy-actions">
          <button type="button" class="btn btn-primary" id="gen">
            ${icon("sparkles", 18)}
            <span>生成加速链接</span>
          </button>
          <button type="button" class="btn btn-ghost" id="copy" disabled>
            ${icon("copy", 18)}
            <span>复制</span>
          </button>
        </div>
        <div class="out-box" id="out" hidden>
          <a id="out-a" href="#" target="_blank" rel="noopener"></a>
        </div>
      </div>
    </section>

    <section class="section foot-section">
      <div class="foot-grid">
        <div>
          <p class="eyebrow">Source</p>
          <p class="mono small">storage.googleapis.com/grok-build-public-artifacts/cli</p>
        </div>
        <div>
          <p class="eyebrow">Pipeline</p>
          <p class="mono small">GCS → GitHub Actions → Release → DL</p>
        </div>
        <div>
          <p class="eyebrow">Disclaimer</p>
          <p class="muted small">Unofficial redistributor of public binaries. Not affiliated with xAI / SpaceXAI.</p>
        </div>
      </div>
    </section>
  </main>

  <script>
    (function () {
      var origin = ${JSON.stringify(origin)};
      var src = document.getElementById('src');
      var gen = document.getElementById('gen');
      var copy = document.getElementById('copy');
      var out = document.getElementById('out');
      var outA = document.getElementById('out-a');
      var last = '';
      function build(v) {
        v = (v || '').trim();
        if (!v) return '';
        if (!/^https?:\\/\\//i.test(v)) v = 'https://' + v;
        return origin + '/' + v;
      }
      gen.addEventListener('click', function () {
        last = build(src.value);
        if (!last) return;
        out.hidden = false;
        outA.href = last;
        outA.textContent = last;
        copy.disabled = false;
      });
      copy.addEventListener('click', function () {
        if (!last) return;
        navigator.clipboard.writeText(last).then(function () {
          copy.querySelector('span').textContent = '已复制';
          setTimeout(function () { copy.querySelector('span').textContent = '复制'; }, 1600);
        });
      });
    })();
  </script>
</body>
</html>`;
}

function renderAssets(release, origin) {
  const assets = release.assets || [];
  if (!assets.length) return `<p class="muted">此版本无附件</p>`;

  // Prefer binary platforms first
  const order = (name) => {
    const n = name.toLowerCase();
    if (n.includes("windows")) return 0;
    if (n.includes("linux-x86")) return 1;
    if (n.includes("linux-aarch") || n.includes("linux-arm")) return 2;
    if (n.includes("macos-aarch") || n.includes("darwin-arm")) return 3;
    if (n.includes("macos") || n.includes("darwin")) return 4;
    if (n.includes("sha256") || n === "manifest.json") return 9;
    return 5;
  };
  const sorted = assets.slice().sort((a, b) => order(a.name) - order(b.name));

  return sorted
    .map((a) => {
      const accel = origin + "/" + a.browser_download_url;
      const platform = detectPlatform(a.name);
      const size = formatBytes(a.size);
      return `<a class="asset" href="${escapeHtml(accel)}">
        <span class="asset-ico" aria-hidden="true">${platformIcon(platform)}</span>
        <span class="asset-body">
          <span class="asset-name mono">${escapeHtml(a.name)}</span>
          <span class="asset-meta muted">${escapeHtml(platform)} · ${size}</span>
        </span>
        <span class="asset-go">${icon("download", 18)}</span>
      </a>`;
    })
    .join("");
}

function detectPlatform(name) {
  const n = name.toLowerCase();
  if (n.includes("windows")) return "Windows x64";
  if (n.includes("linux-x86_64") || n.includes("linux-amd64")) return "Linux x64";
  if (n.includes("linux-aarch") || n.includes("linux-arm64")) return "Linux ARM64";
  if (n.includes("macos-aarch") || n.includes("darwin-arm")) return "macOS Apple Silicon";
  if (n.includes("macos") || n.includes("darwin")) return "macOS Intel";
  if (n.includes("sha256")) return "Checksums";
  if (n.includes("manifest")) return "Manifest";
  return "Asset";
}

function platformIcon(platform) {
  if (platform.startsWith("Windows")) return icon("monitor", 20);
  if (platform.startsWith("Linux")) return icon("terminal", 20);
  if (platform.startsWith("macOS")) return icon("apple", 20);
  if (platform === "Checksums") return icon("shield-check", 20);
  return icon("file", 20);
}

function formatBytes(n) {
  if (!n && n !== 0) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? v : v.toFixed(1)) + " " + u[i];
}

// ─── Lucide-like inline SVG (stroke icons, no emoji) ────────────────────────

function icon(name, size = 20) {
  const common = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
  const paths = {
    zap: `<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>`,
    "key-round": `<path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>`,
    "arrow-right": `<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>`,
    download: `<path d="M12 15V3"/><path d="m7 10 5 5 5-5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>`,
    github: `<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4"/><path d="M9 18c-4.5 2-5-2-7-2"/>`,
    "external-link": `<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`,
    "log-out": `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>`,
    tag: `<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.4 2.4 0 0 0 3.4 0l5.586-5.586a2.4 2.4 0 0 0 0-3.4z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>`,
    link: `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`,
    sparkles: `<path d="M9.9 2.1 11 6l3.9 1.1L11 8.2 9.9 12 8.8 8.2 5 7.1 8.8 6 9.9 2.1z"/><path d="M19 8v4"/><path d="M17 10h4"/><path d="m5 16 1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3z"/>`,
    copy: `<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>`,
    monitor: `<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>`,
    terminal: `<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>`,
    // apple-like simple fruit path (generic, not trademark logo)
    apple: `<path d="M12 6c2-3 5-3 5-3s0 3-2 5"/><path d="M12 20c-4 0-7-3.5-7-8 0-3.5 2.5-6 5-6 1.2 0 2 .5 2.5.5S13.8 6 15 6c2.5 0 5 2.5 5 6 0 4.5-3 8-8 8z"/>`,
    "shield-check": `<path d="M20 13c0 5-3.5 7.5-7.7 8.7a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.3a1 1 0 0 1 1.2 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>`,
    file: `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>`,
  };
  return `<svg ${common}>${paths[name] || paths.file}</svg>`;
}

function sharedHead() {
  // Fonts: Syne (display) + DM Sans (body) + JetBrains Mono — Google Fonts OFL/Apache
  return `
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;500&family=Syne:wght@600;700;800&display=swap" rel="stylesheet"/>
<style>
${CSS}
</style>`;
}

// ─── Design system CSS ──────────────────────────────────────────────────────

const CSS = `
:root{
  --bg:#07080c;
  --bg-elev:#0e1018;
  --surface:rgba(18,20,30,.72);
  --stroke:rgba(255,255,255,.08);
  --stroke-2:rgba(255,255,255,.14);
  --text:#f2f1ec;
  --muted:#8b8d9a;
  --accent:#d6ff4b;
  --accent-2:#6ee7ff;
  --danger:#ff6b6b;
  --ease:cubic-bezier(.16,1,.3,1);
  --font-d:"Syne",system-ui,sans-serif;
  --font-b:"DM Sans",system-ui,sans-serif;
  --font-m:"JetBrains Mono",ui-monospace,monospace;
  --r:18px;
  --shadow:0 30px 80px rgba(0,0,0,.45);
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;min-height:100vh;color:var(--text);
  font-family:var(--font-b);font-optical-sizing:auto;
  background:var(--bg);
  overflow-x:hidden;
}
a{color:inherit;text-decoration:none}
button,input{font:inherit;color:inherit}
.mono{font-family:var(--font-m);font-feature-settings:"ss01"}
.small{font-size:.85rem;line-height:1.5}
.muted{color:var(--muted)}
.eyebrow{
  font-family:var(--font-m);font-size:.72rem;letter-spacing:.16em;
  text-transform:uppercase;color:var(--accent-2);margin:0 0 .75rem;
}

/* Atmosphere */
.noise{
  pointer-events:none;position:fixed;inset:0;z-index:0;opacity:.045;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
  mix-blend-mode:overlay;
}
.orb{pointer-events:none;position:fixed;border-radius:50%;filter:blur(80px);z-index:0}
.orb-a{width:48vw;height:48vw;top:-12vw;right:-8vw;background:radial-gradient(circle,rgba(110,231,255,.22),transparent 70%)}
.orb-b{width:40vw;height:40vw;bottom:-10vw;left:-10vw;background:radial-gradient(circle,rgba(214,255,75,.14),transparent 70%)}
.grid-bg{
  pointer-events:none;position:fixed;inset:0;z-index:0;opacity:.25;
  background-image:
    linear-gradient(rgba(255,255,255,.03) 1px,transparent 1px),
    linear-gradient(90deg,rgba(255,255,255,.03) 1px,transparent 1px);
  background-size:64px 64px;
  mask-image:radial-gradient(ellipse 70% 60% at 50% 0%,#000 20%,transparent 75%);
}

.reveal{animation:rise .9s var(--ease) both}
.d1{animation-delay:.08s}.d2{animation-delay:.16s}.d3{animation-delay:.24s}.d4{animation-delay:.32s}
@keyframes rise{
  from{opacity:0;transform:translateY(18px) scale(.985)}
  to{opacity:1;transform:none}
}
@media (prefers-reduced-motion:reduce){
  .reveal{animation:none}
  .orb{display:none}
  html{scroll-behavior:auto}
}

/* Gate */
.gate-body{display:grid;place-items:center;min-height:100vh;padding:24px}
.gate{position:relative;z-index:1;width:min(420px,100%)}
.gate-brand{display:flex;gap:14px;align-items:center;margin-bottom:28px}
.gate-title{font-family:var(--font-d);font-weight:800;font-size:clamp(2rem,6vw,2.6rem);margin:0;letter-spacing:-.03em}
.mark{
  width:48px;height:48px;border-radius:14px;display:grid;place-items:center;
  background:linear-gradient(145deg,rgba(214,255,75,.2),rgba(110,231,255,.08));
  border:1px solid var(--stroke-2);color:var(--accent);box-shadow:var(--shadow);
}
.mark.sm{width:36px;height:36px;border-radius:11px}
.gate-card,.proxy-card,.release-card{
  position:relative;
  background:var(--surface);backdrop-filter:blur(18px);
  border:1px solid var(--stroke);border-radius:var(--r);
  padding:24px;box-shadow:var(--shadow);
}
.lbl{display:block;font-size:.85rem;color:var(--muted);margin-bottom:8px}
.field{position:relative}
.field-ico{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--muted);display:grid}
.field input{
  width:100%;padding:14px 14px 14px 44px;border-radius:12px;
  border:1px solid var(--stroke-2);background:rgba(0,0,0,.35);
  outline:none;transition:border-color .25s var(--ease),box-shadow .25s var(--ease);
}
.field input:focus{border-color:rgba(214,255,75,.45);box-shadow:0 0 0 3px rgba(214,255,75,.12)}
.err{color:var(--danger);font-size:.9rem;margin:12px 0 0}
.hint{margin:16px 0 0;font-size:.78rem;color:var(--muted);line-height:1.5}
.gate-foot{margin-top:22px;text-align:center;color:var(--muted);font-size:.75rem}

/* Buttons */
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  padding:12px 18px;border-radius:999px;border:1px solid transparent;
  cursor:pointer;transition:transform .25s var(--ease),background .25s var(--ease),border-color .25s var(--ease),opacity .2s;
  font-weight:600;font-size:.95rem;
}
.btn:hover{transform:translateY(-1px)}
.btn:active{transform:translateY(0)}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.btn-primary{background:var(--accent);color:#111;border-color:rgba(255,255,255,.08)}
.btn-primary:hover{background:#e4ff78}
.btn-ghost{background:rgba(255,255,255,.03);border-color:var(--stroke-2);color:var(--text)}
.btn-ghost:hover{border-color:rgba(255,255,255,.28);background:rgba(255,255,255,.06)}
.btn-block{width:100%;margin-top:16px}
.btn.sm{padding:8px 12px;font-size:.85rem}

/* Top */
.top{position:sticky;top:0;z-index:20;backdrop-filter:blur(16px);background:rgba(7,8,12,.65);border-bottom:1px solid var(--stroke)}
.top-inner{
  max-width:1120px;margin:0 auto;padding:14px 20px;
  display:flex;align-items:center;justify-content:space-between;gap:16px;
}
.brand{display:flex;align-items:center;gap:10px;font-family:var(--font-d);font-weight:700;letter-spacing:-.02em}
.nav{display:flex;align-items:center;gap:18px;font-size:.9rem;color:var(--muted)}
.nav a{display:inline-flex;align-items:center;gap:6px;transition:color .2s}
.nav a:hover{color:var(--text)}
.nav-out{padding:6px 10px;border-radius:999px;border:1px solid var(--stroke)}

/* Hero */
main{position:relative;z-index:1}
.hero{
  max-width:1120px;margin:0 auto;padding:clamp(40px,8vw,88px) 20px 40px;
  display:grid;grid-template-columns:1.15fr .85fr;gap:clamp(28px,5vw,56px);align-items:center;
}
.display{
  font-family:var(--font-d);font-weight:800;line-height:.92;
  font-size:clamp(3rem,9vw,5.6rem);letter-spacing:-.045em;margin:0 0 1.1rem;
}
.display .line{display:block}
.accent-line{
  background:linear-gradient(105deg,var(--accent) 10%,var(--accent-2) 90%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
}
.lede{font-size:1.05rem;line-height:1.65;color:var(--muted);max-width:38ch;margin:0 0 1.6rem}
.hero-actions{display:flex;flex-wrap:wrap;gap:12px}

.hero-panel{
  position:relative;border-radius:24px;padding:22px;
  background:linear-gradient(160deg,rgba(18,22,34,.9),rgba(10,12,18,.92));
  border:1px solid var(--stroke-2);box-shadow:var(--shadow);overflow:hidden;
}
.panel-glow{
  position:absolute;inset:-40% -20% auto auto;width:70%;height:70%;
  background:radial-gradient(circle,rgba(214,255,75,.18),transparent 70%);
}
.panel-head{position:relative;display:flex;align-items:center;gap:8px;margin-bottom:18px;color:var(--muted);font-size:.8rem}
.dot{width:8px;height:8px;border-radius:50%;background:var(--accent);box-shadow:0 0 12px var(--accent);animation:pulse 2.4s ease infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
.stat-grid{position:relative;display:grid;grid-template-columns:1fr 1fr;gap:12px}
.stat{
  padding:14px;border-radius:14px;background:rgba(255,255,255,.03);
  border:1px solid var(--stroke);display:flex;flex-direction:column;gap:6px;
}
.stat-l{font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.stat-v{font-size:1.05rem;font-weight:600}
.panel-note{position:relative;margin:16px 0 0;font-size:.8rem}

/* Sections */
.section{max-width:1120px;margin:0 auto;padding:28px 20px 12px}
.section-head{margin-bottom:18px}
.h2{font-family:var(--font-d);font-size:clamp(1.6rem,3vw,2.1rem);margin:0 0 .35rem;letter-spacing:-.03em}
.h3{margin:0;font-size:1.35rem;letter-spacing:-.02em}
.release-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:18px}
.asset-list{display:flex;flex-direction:column;gap:8px}
.asset{
  display:grid;grid-template-columns:auto 1fr auto;gap:14px;align-items:center;
  padding:14px 16px;border-radius:14px;border:1px solid var(--stroke);
  background:rgba(0,0,0,.22);transition:border-color .25s var(--ease),background .25s var(--ease),transform .25s var(--ease);
}
.asset:hover{border-color:rgba(214,255,75,.35);background:rgba(214,255,75,.04);transform:translateX(3px)}
.asset-ico{color:var(--accent-2);display:grid}
.asset-name{display:block;font-size:.9rem;word-break:break-all}
.asset-meta{display:block;font-size:.78rem;margin-top:3px}
.asset-go{color:var(--accent)}

.hist{display:flex;flex-direction:column;gap:8px}
.hist-row{
  display:grid;grid-template-columns:140px 1fr auto auto;gap:12px;align-items:center;
  padding:14px 16px;border-radius:14px;border:1px solid var(--stroke);
  background:var(--surface);transition:border-color .2s,transform .25s var(--ease);
}
.hist-row:hover{border-color:var(--stroke-2);transform:translateX(2px)}
.hist-tag{color:var(--accent);font-size:.85rem}
.hist-name{font-weight:500}
.hist-meta{font-size:.8rem}

.proxy-actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
.out-box{
  margin-top:16px;padding:14px;border-radius:12px;
  background:rgba(0,0,0,.35);border:1px dashed rgba(214,255,75,.35);
  word-break:break-all;font-family:var(--font-m);font-size:.82rem;
}
.out-box a{color:var(--accent-2)}

.foot-section{padding-bottom:64px}
.foot-grid{
  display:grid;grid-template-columns:repeat(3,1fr);gap:20px;
  padding:28px 0;border-top:1px solid var(--stroke);
}

@media (max-width:860px){
  .hero{grid-template-columns:1fr;padding-top:36px}
  .nav a:not(.nav-out){display:none}
  .hist-row{grid-template-columns:1fr auto;grid-template-areas:"tag go" "name name" "meta meta"}
  .hist-tag{grid-area:tag}.hist-name{grid-area:name}.hist-meta{grid-area:meta}
  .hist-row svg{grid-area:go}
  .foot-grid{grid-template-columns:1fr}
}
`;

// ─── utils ──────────────────────────────────────────────────────────────────

function wantsHtml(request) {
  const a = request.headers.get("Accept") || "";
  return a.includes("text/html");
}

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS, POST",
    "access-control-allow-headers": "range, if-range, content-type, x-access-code",
    "access-control-max-age": "86400",
  };
}

function parseCookie(header) {
  const out = {};
  header.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function serializeCookie(name, value, opt = {}) {
  let s = `${name}=${encodeURIComponent(value)}`;
  if (opt.maxAge != null) s += `; Max-Age=${opt.maxAge}`;
  if (opt.path) s += `; Path=${opt.path}`;
  if (opt.httpOnly) s += "; HttpOnly";
  if (opt.secure) s += "; Secure";
  if (opt.sameSite) s += `; SameSite=${opt.sameSite}`;
  return s;
}

function b64url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sanitizeFilename(name) {
  return name.replace(/[^\w.\-()+@]+/g, "_").slice(0, 180);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
