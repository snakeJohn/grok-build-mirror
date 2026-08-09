# Grok Build 自动镜像（GCS → GitHub Release + DL 加速）

从官方公开 CDN 拉取 Grok Build 客户端，发布到 **GitHub Release**，经自建 Cloudflare Worker **DL** 加速下载。

```text
storage.googleapis.com/grok-build-public-artifacts/cli
        │
        ▼
  GitHub Actions (每 6 小时 / 手动)
        │
        └─► GitHub Release  (tag: grok-x.y.z)
                  │
                  └─► DL Worker（访问码门控 · 边缘加速）
```

> 非官方镜像，仅转发已公开安装包。客户端登录 / 模型调用仍走 xAI 官方服务。

---

## 仓库与加速站

| 项 | 地址 |
|----|------|
| GitHub | https://github.com/snakeJohn/grok-build-mirror |
| 加速门户 | https://dl.gijmail.workers.dev |
| Worker 源码 | [`cf-gh-proxy/`](cf-gh-proxy/) |

### 下载示例（需先登录加速站或带访问码）

```text
# 门户登录后页面一键下载，或：
https://dl.gijmail.workers.dev/https://github.com/snakeJohn/grok-build-mirror/releases/download/grok-1.0.0/grok-1.0.0-windows-x86_64.exe?code=你的访问码
```

访问码为 Cloudflare Secret `ACCESS_CODE`（部署时配置，勿提交到 git）。

---

## 目录结构

```text
├── .github/workflows/mirror.yml   # 定时同步 GCS → Release
├── mirror/latest.json             # 已同步版本状态
├── scripts/
│   ├── config.py
│   ├── fetch_artifacts.py
│   ├── publish_github_release.sh
│   └── run_local.ps1
└── cf-gh-proxy/                   # Cloudflare Worker「dl」
```

---

## 本地 / CI

### 同步产物

```powershell
cd scripts
python fetch_artifacts.py --channel stable --out ..\artifacts --state ..\mirror\latest.json --force
```

### 部署加速站

```powershell
cd cf-gh-proxy
npm i
$env:CLOUDFLARE_API_TOKEN = "..."
$env:CLOUDFLARE_ACCOUNT_ID = "..."
# 首次或轮换访问码
echo "你的访问码" | npx wrangler secret put ACCESS_CODE
npx wrangler deploy
```

---

## 官方产物命名

| 平台 | 文件名示例 |
|------|------------|
| Windows x64 | `grok-1.0.0-windows-x86_64.exe` |
| Linux x64 | `grok-1.0.0-linux-x86_64` |
| Linux ARM | `grok-1.0.0-linux-aarch64` |
| macOS Intel | `grok-1.0.0-macos-x86_64` |
| macOS Apple Silicon | `grok-1.0.0-macos-aarch64` |

版本：`https://storage.googleapis.com/grok-build-public-artifacts/cli/stable`

---

## 安全

- 访问码只放 Cloudflare Secret / 本地环境，不入库  
- Worker 默认仅允许 `snakeJohn/grok-build-mirror` 的 Release 下载  
- 仓库内只提交状态小文件，二进制只在 Release  

---

## 前端说明（DL 门户）

见 [`cf-gh-proxy/ASSETS.md`](cf-gh-proxy/ASSETS.md)：dark-cinematic + neo-geo 风格，Syne / DM Sans / JetBrains Mono，Lucide 线性图标，无 emoji。
