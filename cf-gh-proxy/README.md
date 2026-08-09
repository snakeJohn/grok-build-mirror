# DL — GitHub Release 加速门户

短域名 Worker：`dl` → `https://dl.<subdomain>.workers.dev`

## 功能

- 访问码门控（Secret `ACCESS_CODE`）
- 展示 `MIRROR_REPO` 最新 Release 与加速下载
- 任意白名单内 GitHub 下载链接反代（支持 Range）

## 部署

```bash
npm i
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
printf '%s' 'your-code' | npx wrangler secret put ACCESS_CODE
npx wrangler deploy
```

## 配置（wrangler.jsonc vars）

| 变量 | 说明 |
|------|------|
| `ALLOWED_REPOS` | 逗号分隔 `owner/repo` |
| `MIRROR_REPO` | 门户展示的镜像仓库 |
| `SITE_TITLE` | 品牌短名 |

## 素材

见 [ASSETS.md](./ASSETS.md)。
