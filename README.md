# 局域网文件互传与聊天（LAN Transfer）

在同一 Wi‑Fi / 局域网内，用浏览器打开本机部署的网页，即可**群聊广播**、**一对一私聊**、**上传与下载文件**，无需公网或第三方账号。服务端使用 **FastAPI**，Web 界面为 **React + Ant Design**，构建后由同一进程托管静态资源。

---

## 功能概览


| 能力   | 说明                                                       |
| ---- | -------------------------------------------------------- |
| 群组聊天 | 全员可见的广播消息                                                |
| 私聊   | 选择在线用户单独发消息（对方需在线）                                       |
| 文件传输 | 上传至服务端 `uploads/`，列表下载；聊天内图片/视频可内联预览                     |
| 在线列表 | WebSocket 维护当前连接用户昵称与 IP                                 |
| 聊天记录 | 持久化至 `data/chat_messages.jsonl`（首次运行自动创建目录）              |
| 管理端  | `http://127.0.0.1:端口/admin`（**仅本机回环**可打开，用于清理上传、清空聊天记录等） |


---

## 技术栈

- **后端**：Python 3、FastAPI、Uvicorn、WebSocket；本机默认 **pywebview** 管理壳  
- **前端**：Vite 5、React 18、Ant Design 5  
- **构建产物**：输出到 `static/spa/`，由 `server.py` 提供 `/` 与静态资源

---

## 目录结构（简要）

```
├── server.py           # 主服务：HTTP / WS / 静态页 / 上传与聊天逻辑
├── requirements.txt    # Python 依赖
├── start.sh            # 可选：创建 .venv、安装依赖并启动 server.py
├── frontend/           # 前端源码（Vite + React）
├── static/spa/         # 前端构建输出（部署前需 npm run build）
├── uploads/            # 用户上传文件（默认不入库，见 .gitignore）
└── data/               # 本地数据目录（如聊天记录 jsonl）
```

---

## 环境要求

- Python **3.9+**（推荐与本地已验证版本一致）  
- Node.js **18+**（仅在前端需要重新构建时）

---

## 快速开始

### 1. 安装 Python 依赖

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

或使用项目脚本（自动创建 `.venv` 并安装依赖）：

```bash
chmod +x start.sh
./start.sh
```

### 2. 构建前端（首次或修改 `frontend/` 后）

```bash
cd frontend
npm install
npm run build
cd ..
```

构建完成后，产物在 `static/spa/`。

### 3. 启动服务

```bash
python server.py
```

默认行为（本机图形环境可用时）：

- 在**后台线程**启动 FastAPI / Uvicorn（仍监听 `HOST`，一般为 `0.0.0.0`，局域网可访问聊天页）。
- 在主线程用 **pywebview** 打开 `**http://127.0.0.1:端口/admin/`** 作为「壳子窗口」，即本机管理页；关闭该窗口后进程结束。

若不需要桌面窗口（SSH、无显示器服务器、或不想装 pywebview 图形依赖），可任选其一：

```bash
NO_WEBVIEW=1 python server.py
# 或
python server.py --no-webview
```

此时仅控制台运行 Web 服务，与旧版行为一致。

终端会打印本机访问地址与检测到的**局域网 IP**；同网段设备使用 `http://<你的局域网IP>:8888` 访问主站（默认端口 **8888**）。若需改端口，请设置环境变量 **`PORT`** 后重新启动程序。

### 环境变量（可选）


| 变量           | 默认值                                              | 含义                                              |
| ------------ | ------------------------------------------------ | ----------------------------------------------- |
| `PORT`       | 未设置时默认 **8888** | 非空时作为 HTTP 监听端口 |
| `HOST`       | `0.0.0.0`                                        | 绑定地址                                            |
| `NO_WEBVIEW` | 未设置                                              | 设为 `1` / `true` / `yes` 时关闭 WebView，仅启动 HTTP 服务 |


示例：

```bash
PORT=9000 python server.py
```

---

## 主要 HTTP 接口（供联调或脚本参考）

- `GET /api/health` — 健康检查  
- `GET /api/online` — 当前在线设备列表  
- `GET /api/files` — 已上传文件列表  
- `POST /api/upload` — 上传文件  
- `GET /api/files/{name}/download` — 下载（附件）  
- `GET /api/files/{name}/inline` — 内联预览（图片/视频等）  
- `GET /api/suggest-nick` — 根据 UA 建议默认昵称  
- `WebSocket /ws` — 实时消息与在线状态

管理类接口（如清空上传、清空聊天记录）在 `**/admin` 管理端页面** 中调用，且服务端会校验**仅本机**可访问相关路由。

---

## 前端开发说明

默认联调方式：修改 `frontend/` 后执行 `npm run build`，再刷新浏览器即可。若要在本机使用 Vite 开发服务器（`npm run dev`），需自行配置与后端同源的 API/WebSocket 代理或访问策略，当前仓库未内置 `vite` 代理。

---

## 许可与说明

本项目面向**可信局域网**场景设计，未内置完整身份认证与加密；请勿直接暴露到公网。上传文件与聊天内容请自行做好备份与合规管理。