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
| 构建产物 | 在 `frontend` 执行 `npm run build` → 输出到 `static/spa/`（主站 `index.html`、管理端 `admin.html`）    |


## 目录速览

```
server.py              # 唯一后端入口：HTTP/WS/上传/聊天/静态资源
requirements.txt      # 运行依赖（含 pywebview、Pillow，供 create_icon 与图标生成）
requirements-build.txt # 仅打包：PyInstaller（Pillow 已在 requirements.txt）
lan_transfer.spec      # PyInstaller 配置（datas 打入 static/spa、图标等）
create_icon.py         # 按品牌四宫格矢量逻辑绘制并生成 icons/app_icon.ico（及 macOS 下 app_icon.icns）
icons/                 # 构建产物图标（app_icon.* 已 .gitignore，勿强依赖提交）
start.sh               # macOS/Linux：创建 .venv、清华 pip 源、npm 镜像、装依赖、启动 server.py
start.bat              # Windows：与 start.sh 等价（.venv、pip/npm 镜像、npm install、启动 server.py）
frontend/              # 前端源码
static/spa/            # 构建后的 SPA（需 build 后才有完整页面）
static/notification.mp3 # 新消息提示音（用户自行维护；勿擅自覆盖或重新生成，见下文）
static/icon.png        # 可选；仅用于站点路径 /static/icon.png（与打包图标脚本无关）
uploads/               # 用户上传（.gitignore）；打包后实际在 ~/Documents/lan-transfer/uploads/
data/                  # 聊天记录等（.gitignore）；打包后在 ~/Documents/lan-transfer/data/
README.md              # 给人看的说明
```

## 常用命令

**macOS / Linux**

```bash
# Python（建议虚拟环境）
pip install -r requirements.txt
python server.py                    # 默认可能带 WebView 打开 /admin
NO_WEBVIEW=1 python server.py       # 仅控制台服务

# 一键（含 venv、依赖、可选图标与 npm）
chmod +x start.sh && ./start.sh

# 前端改完需构建（主站与管理端一起）
cd frontend && npm install && npm run build

# 桌面可执行文件（先 SPA，再图标，再 PyInstaller）
pip install -r requirements.txt -r requirements-build.txt
cd frontend && npm ci && npm run build && cd ..
python create_icon.py
pyinstaller lan_transfer.spec --clean
# 产物：dist/lan_transfer.exe（Windows）或 dist/lan_transfer.app（macOS）
# 冻结后静态资源来自打包内只读目录；上传与 data 写入 ~/Documents/lan-transfer/
```

**Windows（命令提示符）**

```bat
start.bat
```

`start.bat` 会创建 `.venv`、安装依赖与前端 `npm install`，最后执行 `python server.py`。若只要控制台、不要 WebView，可在同一终端先执行 `set NO_WEBVIEW=1` 再运行 `call .venv\Scripts\activate.bat` 与 `python server.py`（或自行改 `start.bat` 末尾）。

## 改代码时注意

- **不要无故改依赖版本**（用户约定）。
- `**static/notification.mp3`**：新消息提示音由用户自行维护；**不要覆盖、重新生成或修改该文件**（除非用户明确要求）。
- **聊天 UI、滚动、底栏**：逻辑集中在 `frontend/src/App.jsx`；消息区滚动用 `chatScrollRef` 设 `scrollTop`，**不要用 `scrollIntoView`**（会破坏固定底栏布局）。
- **后端路由**：上传/下载/内联预览在 `server.py`；管理接口带本机校验。
- **文档**：用户未要求不要新建大段 Markdown；本文件用于协作说明。

## 变更备忘（近期，便于对照）

以下摘要便于对照；**改 `frontend/src/admin.jsx` 或主站 `App.jsx` 后**，需在 `frontend` 目录执行 `npm run build` 才会更新 `static/spa/`（含 `admin.html` / `index.html` 引用的 `assets/*.js`）。

- `**start.sh` / `start.bat`**：`start.sh` 在 `LANG` 为空或为 `C`/`POSIX` 时默认 `en_US.UTF-8`；安装提示使用半角标点。`start.bat` 使用 `chcp 65001` 减轻中文乱码。
- `**server.py`**：上传自动清理后台线程通过 `**lifespan`** 启动（不再使用已弃用的 `on_event("startup")`）；运行期 防系统休眠/关屏（`_prevent_system_sleep_*`）；`/api/online` 的 `list_public()` 含 `**online**` 字段供管理端展示。
- **管理页**：`frontend/admin.html` 用 `**#admin-app-scroll`** 包裹根节点、`body` 不滚动，减轻 Modal 打开时背后整页宽度跳变；在线用户表 **昵称 / 状态** 列顺序与状态配色；已上传文件预览与表格列宽等与弹窗相关的布局调整见 `frontend/src/admin.jsx`。
- `**static/notification.mp3`**：用户维护，勿擅自替换。

## 安全与边界

面向 **可信局域网**；无完整鉴权。不要把服务裸暴露到公网。

## GitHub 工作流

若**只在公有仓 `niugengyun/lan-transfer` 上开发并推送**，使用 `.github/workflows/release.yml` 即可。

- **触发**：推送 `v*` tag，或 `workflow_dispatch` 仅构建产物。
- **产物**：macOS 上生成 `lan-transfer-<tag>-macos.dmg` 等；Windows 上生成 `lan_transfer.exe` 并打 zip。**仅 tag 推送**时 `release` 任务将文件发到当前仓库 Release（`GITHUB_TOKEN`；仓库需允许 workflow 写入 contents，见 Settings → Actions → General）。

发版前将 `version.py` 的 `__version__` 与 Git **tag**（如 `v0.1.4`）对齐。

## 在线升级（与 veo3free 前端行为对齐）

- **后端**：`version.py`（`GITHUB_REPO = "niugengyun/lan-transfer"`）、`updater.py`（请求 `releases/latest`；macOS 优先 `*macos*.dmg` / `*macos*.zip`，Windows 优先 `*windows*.zip` / `.exe`）。
- **接口**：`GET /api/app/version`；`GET /api/update/check` **仅本机 127.0.0.1**。
- **控制台 `/admin`**：约 3 秒后静默检查更新；有新版本弹窗，「前往下载」走 `POST /api/admin/open-browser`。局域网 Web 聊天页不请求升级。
- **开发跳过检查**：环境变量 `LAN_TRANSFER_DEV=1`（或版本为 `dev`）时不请求 GitHub。

