# Grok Build 自动镜像（GCS → GitHub Release → 123 网盘）

从官方公开 CDN 拉取 Grok Build 客户端，发布到 **GitHub Release**，并上传到 **123 云盘开放平台**。

```text
storage.googleapis.com/grok-build-public-artifacts/cli
        │
        ▼
  GitHub Actions (每 6 小时 / 手动)
        │
        ├─► GitHub Release  (tag: grok-x.y.z)
        │         │
        │         └─► CF Worker 加速下载（国内）
        └─► 123 云盘        (文件夹: GrokBuild/<version>/)
```

## 国内加速下载（已部署）

Worker：`https://gh-release-proxy.gijmail.workers.dev`

```text
# 原 GitHub Release 链接
https://github.com/<你>/<仓>/releases/download/grok-1.0.0/grok-1.0.0-windows-x86_64.exe

# 加速（前面加上 Worker 地址 + /）
https://gh-release-proxy.gijmail.workers.dev/https://github.com/<你>/<仓>/releases/download/grok-1.0.0/grok-1.0.0-windows-x86_64.exe
```

也可打开 Worker 首页粘贴链接自动生成。源码与重新部署见 [`cf-gh-proxy/`](cf-gh-proxy/)。

> 上线镜像仓库后，建议在 `cf-gh-proxy/wrangler.jsonc` 把 `ALLOWED_REPOS` 设为 `你的用户名/仓库名`，避免被当成公共代理刷流量。

> 非官方镜像，仅转发已公开的安装包，方便国内下载。  
> 客户端登录 / 模型调用仍走 xAI 官方服务。

---

## 目录结构

```text
123upload/
├── .github/workflows/mirror.yml   # 定时 + 手动流水线
├── mirror/latest.json             # 已同步版本状态（小文件，进 git）
├── scripts/
│   ├── config.py                  # 常量 / 平台列表
│   ├── fetch_artifacts.py         # 从 GCS 下载
│   ├── publish_github_release.sh  # 创建 GitHub Release
│   └── upload_123pan.py           # 123 开放平台上传
├── .gitignore
└── README.md
```

---

## 1. 创建 GitHub 仓库并推送

```powershell
cd "J:\AI项目\123upload"
git init
git add .
git commit -m "feat: grok build mirror pipeline"
# 换成你的仓库地址
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git branch -M main
git push -u origin main
```

---

## 2. 配置 123 云盘（只开了 VIP 也够用）

开放平台要单独开开发者套餐。**只有 VIP 时用「网页登录」方式**（手机号/邮箱 + 密码），和 OpenList 的「123Pan」驱动同一路，不需要开发者会员。

### 方式 A：VIP 账号密码（推荐，你现在的情况）

仓库 → **Settings → Secrets and variables → Actions → Secrets**：

| Secret | 必填 | 说明 |
|--------|------|------|
| `PAN123_USERNAME` | 是 | 登录手机号或邮箱 |
| `PAN123_PASSWORD` | 是 | 登录密码 |
| `PAN123_PARENT_ID` | 否 | 目标父目录 `fileId`，默认 `0`（根目录） |

> 密码只放在 GitHub Secrets 里，不要写进代码仓库。  
> 这是非官方网页接口，123 以后若改接口可能要跟着修脚本；稳定长期用仍建议以后上开放平台。

### 方式 B：开放平台（有开发者会员时）

| Secret | 说明 |
|--------|------|
| `PAN123_CLIENT_ID` | [开发者平台](https://www.123pan.com/developer) |
| `PAN123_CLIENT_SECRET` | 同上 |

两种都配时，默认优先用 **VIP 账号密码**（`PAN123_MODE=auto`）。

可选 **Variables**（非 Secret）：

| Variable | 默认 | 说明 |
|----------|------|------|
| `PAN123_FOLDER` | `GrokBuild` | 网盘路径前缀 → `GrokBuild/<版本号>/` |
| `PAN123_MODE` | `auto` | `auto` / `vip` / `open` |

两种凭据都不配时：仍会发 **GitHub Release**，只是跳过 123 上传。

---

## 3. 开启 Actions 并跑一次

1. 仓库 **Actions** 页允许 workflow  
2. 打开 **Mirror Grok Build → GitHub Release → 123pan**  
3. **Run workflow**  
   - channel: `stable`  
   - force: 首次可勾选  
4. 成功后检查：  
   - Releases 是否有 `grok-1.0.0` 之类 tag  
   - 123 网盘是否出现 `GrokBuild/1.0.0/`  

定时：默认 **UTC 每 6 小时** 检查一次；版本没变则跳过。

---

## 4. 本机手动试跑（可选）

需要本机能访问 GCS。

```powershell
cd "J:\AI项目\123upload\scripts"

# 只下载
python fetch_artifacts.py --channel stable --out ..\artifacts --state ..\mirror\latest.json --force

# 上传 123（VIP 账号密码）
$env:PAN123_USERNAME = "手机号或邮箱"
$env:PAN123_PASSWORD = "登录密码"
python upload_123pan.py --dir ..\artifacts
```

GitHub Release 发布依赖 `gh` CLI，一般在 Actions 里跑即可：

```bash
export GH_TOKEN=ghp_xxx
./scripts/publish_github_release.sh
```

---

## 5. 官方产物命名（勿加空格）

| 平台 | 文件名示例 |
|------|------------|
| Windows x64 | `grok-1.0.0-windows-x86_64.exe` |
| Linux x64 | `grok-1.0.0-linux-x86_64` |
| Linux ARM | `grok-1.0.0-linux-aarch64` |
| macOS Intel | `grok-1.0.0-macos-x86_64` |
| macOS Apple Silicon | `grok-1.0.0-macos-aarch64` |

版本号：`https://storage.googleapis.com/grok-build-public-artifacts/cli/stable`

---

## 6. 安全说明

- **不要** 把 123 登录密码放进 Secret；用开放平台 ClientID/Secret。  
- 仓库里只提交 `mirror/latest.json` 等小文件，**二进制只放 Release / 网盘**。  
- Fork 到公开仓库时，注意 Release 流量与网盘容量。

---

## 7. 常见问题

**Q: Actions 显示 skip 123pan**  
A: 未配置 VIP 的 `PAN123_USERNAME`/`PAN123_PASSWORD`，也未配置开放平台 ClientID/Secret。

**Q: 只有 VIP、没开开发者会员**  
A: 用方式 A 配账号密码即可，不必开开放平台。

**Q: 版本没更新但想重传**  
A: 手动 Run workflow，勾选 `force`。

**Q: 下载 404 / NoSuchKey**  
A: 检查文件名中间是否有空格；正确为 `windows-x86_64`，不是 `windows- x86_64`。

**Q: 只要 GitHub、不要 123**  
A: 不配 123 Secret，或 Run 时勾选 `skip_123pan`。
