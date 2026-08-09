# GitHub Release 加速（Cloudflare Worker）

反代 GitHub `releases/download`、`archive`、`raw` 下载，便于国内访问。

## 部署

```bash
cd cf-gh-proxy
npm i
# 需环境变量 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
npx wrangler deploy
```

## 使用

```text
https://<worker子域>.workers.dev/https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
```

打开 Worker 根路径有粘贴生成页。

## 限制仓库（推荐）

`wrangler.jsonc` → `vars.ALLOWED_REPOS`：

```jsonc
"ALLOWED_REPOS": "yourname/123upload"
```

空字符串 = 允许所有公开 GitHub 下载路径（易被刷流量，上线后建议收紧）。

## Secrets（GitHub Actions 部署时）

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
