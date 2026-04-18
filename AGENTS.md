# AGENTS.md — 本仓库说明（给 AI / 代理用）

## 项目是做什么的

**局域网互传（LAN Transfer）**：在同一 Wi‑Fi / 局域网内，用浏览器访问本机跑的服务，实现 **群组广播聊天**、**一对一私聊**、**上传/下载文件**（含聊天里图片/视频预览）。**不需要公网或账号**。

- **主站**：群聊 + 私聊 UI（微信风格），WebSocket 实时消息，聊天记录落在 `data/chat_messages.jsonl`。
- **本机管理页**：`/admin`，仅 **127.0.0.1** 可打开（清上传、清聊天记录等）。
- **可选桌面壳**：直接运行 `python server.py` 时，若已安装 `pywebview` 且未设 `NO_WEBVIEW=1`，会弹窗打开管理页；否则只起 HTTP 服务。

## 技术栈


| 部分   | 说明                                                                                       |
| ---- | ---------------------------------------------------------------------------------------- |
| 后端   | `server.py` — FastAPI、Uvicorn、WebSocket、`static/spa` 托管、`uploads/` 存文件                   |
| 前端源码 | `frontend/` — Vite 5 + React 18 + Ant Design 5，入口 `src/App.jsx`（主站）、`src/admin.jsx`（管理端） |
| 构建产物 | `frontend` 执行 `npm run build` → 输出到 `**static/spa/`**（主站 `index.html`、管理端 `admin.html`）  |


## 目录速览

```
server.py              # 唯一后端入口：HTTP/WS/上传/聊天/静态资源
requirements.txt      # 运行依赖（含 pywebview、Pillow，供 create_icon 与图标生成）
requirements-build.txt # 仅打包：PyInstaller（Pillow 已在 requirements.txt）
lan_transfer.spec      # PyInstaller 配置（datas 打入 static/spa、图标等）
create_icon.py         # 按品牌四宫格矢量逻辑绘制并生成 icons/app_icon.ico（及 macOS 下 app_icon.icns）
icons/                 # 构建产物图标（app_icon.* 已 .gitignore，勿强依赖提交）
start.sh               # 创建 .venv、清华 pip 源、npm 镜像、装依赖、exec python server.py
frontend/              # 前端源码
static/spa/            # 构建后的 SPA（需 build 后才有完整页面）
static/icon.png        # 可选；仅用于站点路径 /static/icon.png（与打包图标脚本无关）
uploads/               # 用户上传（.gitignore）；打包后实际在 ~/Documents/lan-transfer/uploads/
data/                  # 聊天记录等（.gitignore）；打包后在 ~/Documents/lan-transfer/data/
README.md              # 给人看的说明
```

## 常用命令

```bash
# Python（建议虚拟环境）
pip install -r requirements.txt
python server.py                    # 默认可能带 WebView 打开 /admin
NO_WEBVIEW=1 python server.py       # 仅控制台服务

# 前端改完需构建（主站与管理端一起）
cd frontend && npm install && npm run build

# 桌面可执行文件（参考 veo3free-main：先 SPA，再图标，再 PyInstaller）
pip install -r requirements.txt -r requirements-build.txt
cd frontend && npm ci && npm run build && cd ..
python create_icon.py
pyinstaller lan_transfer.spec --clean
# 产物：dist/lan_transfer.exe（Windows）或 dist/lan_transfer.app（macOS）
# 冻结后静态资源来自打包内只读目录；上传与 data 写入 ~/Documents/lan-transfer/
```

## 改代码时注意

- **不要无故改依赖版本**（用户约定）。
- **聊天 UI、滚动、底栏**：逻辑集中在 `frontend/src/App.jsx`；消息区滚动用 `**chatScrollRef`** 设 `scrollTop`，**不要用 `scrollIntoView`**（会破坏固定底栏布局）。
- **后端路由**：上传/下载/内联预览在 `server.py`；管理接口带本机校验。
- **文档**：用户未要求不要新建大段 Markdown；本文件用于协作说明。

## 安全与边界

面向 **可信局域网**；无完整鉴权。不要把服务裸暴露到公网。

## GitHub 工作流

与 veo3free 那种「先在私有仓开发、再镜像到公有仓并发 Release」不同：若你**只在公有仓 `niugengyun/lan-transfer` 上开发并推送**，只需 `**release.yml`**，不必再保留「私有 → 公有」的同步工作流（原 `push-public.yml` 已移除：它只在「代码在别的仓库、要自动推到公有 `main`」时才有用）。

- `**.github/workflows/release.yml`**：推送 `**v***` tag（或 `**workflow_dispatch**` 仅构建产物）时：在 **macOS** 上 `npm ci`、打包 SPA、`create_icon.py`、`pyinstaller lan_transfer.spec`，用 **create-dmg** 生成 `**lan-transfer-<tag>-macos.dmg`**；在 Windows 上同样流程生成 `**lan_transfer.exe`** 并打成 `**lan-transfer-<tag>-windows.zip**`。**仅 tag 推送**时 `**release`** 任务将上述两个文件发到 **当前仓库** 的 Release（使用 `**GITHUB_TOKEN`**，工作流已声明 `permissions: contents: write`；若组织策略限制默认 `GITHUB_TOKEN` 权限，需在仓库 **Settings → Actions → General** 将 *Workflow permissions* 设为可写入或使用 PAT）。

发版前把 `**version.py`** 里的 `**__version__**` 与 **Git tag** 对齐（与 veo3free 的 `version.py` 用法一致）。

## 在线升级（与 veo3free 前端行为对齐）

- **后端**：`version.py`（`GITHUB_REPO = "niugengyun/lan-transfer"`）、`updater.py`（请求 `releases/latest`；**macOS** 优先 `*macos*.dmg` / `*macos*.zip`，**Windows** 优先 `*windows*.zip` / `.exe`，否则回退含 `lan-transfer` 的 `.zip` 如源码包）。
- **接口**：`GET /api/app/version`（任意客户端可读当前版本）；`GET /api/update/check` **仅本机（127.0.0.1）** 可调（返回字段与 veo3free 的 `check_update` 字典一致：`success`、`has_update`、`current_version`、`latest_version`、`release_notes`、`download_url`、`release_url`）；由服务端访问 GitHub。
- **控制台 `/admin`**：启动约 **3 秒**后静默请求 `GET /api/update/check`；有新版本时弹窗「发现新版本」，「前往下载」经 `POST /api/admin/open-browser` 在系统默认浏览器中打开链接。局域网 **Web 聊天页** 不请求更新、不弹升级窗。
- **开发跳过检查**：环境变量 `**LAN_TRANSFER_DEV=1`**（或当前版本为 `dev`）时服务端不请求 GitHub。

