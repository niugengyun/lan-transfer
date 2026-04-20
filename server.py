"""
局域网文件互传与文本消息服务。
启动后监听 0.0.0.0，同网段设备可通过 http://<本机IP>:端口 访问。
Web 前端构建产物位于 static/spa/。
运行：python server.py（默认在本机打开管理页 WebView 壳 + 后台 Web 服务；仅控制台见下方说明）。
"""
from __future__ import annotations

import asyncio
import atexit
import json
from contextlib import asynccontextmanager
import mimetypes
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from urllib.parse import urlparse
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from version import get_version


def _win_hide_console_subprocess_kw() -> dict[str, Any]:
    """Windows 下 subprocess.run 默认可能短暂弹出控制台；附加 CREATE_NO_WINDOW 避免闪烁（如 arp 查询）。"""
    if platform.system() != "Windows":
        return {}
    fl = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if not fl:
        return {}
    return {"creationflags": fl}


# 运行期间尽量防止系统休眠 / 自动关屏；进程退出后恢复（Windows / 子进程方案在 atexit 中收尾）。
_sleep_prevent_child: Optional[subprocess.Popen] = None
_sleep_prevent_installed: bool = False


def _prevent_system_sleep_cleanup() -> None:
    global _sleep_prevent_child
    if sys.platform == "win32":
        try:
            import ctypes

            ctypes.windll.kernel32.SetThreadExecutionState(0x80000000)  # ES_CONTINUOUS
        except Exception:
            pass
    if _sleep_prevent_child is not None:
        try:
            _sleep_prevent_child.terminate()
            _sleep_prevent_child.wait(timeout=3)
        except Exception:
            pass
        _sleep_prevent_child = None


def _prevent_system_sleep_install() -> None:
    """程序存活期间尽量保持系统唤醒、屏幕常亮（各平台能力不同，失败则静默跳过）。"""
    global _sleep_prevent_child, _sleep_prevent_installed
    if _sleep_prevent_installed:
        return
    ok = False
    try:
        if sys.platform == "win32":
            import ctypes

            ES_CONTINUOUS = 0x80000000
            ES_SYSTEM_REQUIRED = 0x00000001
            ES_DISPLAY_REQUIRED = 0x00000002
            prev = ctypes.windll.kernel32.SetThreadExecutionState(
                ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
            )
            ok = prev != 0
        elif sys.platform == "darwin":
            exe = shutil.which("caffeinate") or "/usr/bin/caffeinate"
            if Path(exe).is_file():
                _sleep_prevent_child = subprocess.Popen(
                    [exe, "-di", "-w", str(os.getpid())],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                ok = _sleep_prevent_child.poll() is None
                if not ok:
                    _sleep_prevent_child = None
        elif sys.platform.startswith("linux"):
            exe = shutil.which("systemd-inhibit")
            if exe:
                _sleep_prevent_child = subprocess.Popen(
                    [
                        exe,
                        "--what=sleep:idle:handle-lid-switch",
                        "--who=lan-transfer",
                        "--why=局域网快传服务运行中",
                        "--mode=block",
                        "sleep",
                        "infinity",
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                ok = _sleep_prevent_child.poll() is None
                if not ok:
                    _sleep_prevent_child = None
    except Exception:
        ok = False
        _sleep_prevent_child = None
    if ok:
        _sleep_prevent_installed = True
        atexit.register(_prevent_system_sleep_cleanup)
        print("已启用：运行期间将尽量防止系统自动休眠与关屏。", flush=True)


def _is_frozen() -> bool:
    return bool(getattr(sys, "frozen", False))


def _bundle_root() -> Path:
    """只读资源根（含 static/spa）。PyInstaller onefile 用 sys._MEIPASS。"""
    if _is_frozen():
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _writable_root() -> Path:
    """可写根：开发时为项目目录；打包后为 ~/Documents/lan-transfer。"""
    if _is_frozen():
        root = Path.home() / "Documents" / "lan-transfer"
        root.mkdir(parents=True, exist_ok=True)
        return root
    return Path(__file__).resolve().parent


BUNDLE_ROOT = _bundle_root()
WORK_ROOT = _writable_root()

UPLOAD_DIR = WORK_ROOT / "uploads"
STATIC_DIR = BUNDLE_ROOT / "static"
SPA_DIR = STATIC_DIR / "spa"

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
if not _is_frozen():
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    SPA_DIR.mkdir(parents=True, exist_ok=True)

DATA_DIR = WORK_ROOT / "data"
CHAT_LOG = DATA_DIR / "chat_messages.jsonl"
_CHAT_LOG_LOCK = threading.RLock()

UPLOAD_AUTO_PURGE_SETTINGS = DATA_DIR / "upload_auto_purge.json"
_UPLOAD_AUTO_PURGE_FILE_LOCK = threading.RLock()
_uvicorn_loop: Optional[asyncio.AbstractEventLoop] = None

DEFAULT_HTTP_PORT = 8888


def _server_port() -> int:
    """监听端口：环境变量 PORT（非空）优先，否则默认 DEFAULT_HTTP_PORT。"""
    env_raw = os.environ.get("PORT")
    if env_raw is not None and str(env_raw).strip() != "":
        try:
            v = int(str(env_raw).strip())
            if 1 <= v <= 65535:
                return v
        except ValueError:
            pass
    return DEFAULT_HTTP_PORT


@asynccontextmanager
async def _app_lifespan(_app: FastAPI):
    """应用存活期：注册事件循环并启动上传自动清理后台线程（替代已弃用的 on_event('startup')）。"""
    global _uvicorn_loop
    _uvicorn_loop = asyncio.get_running_loop()
    th = threading.Thread(target=_upload_auto_purge_loop, name="upload-auto-purge", daemon=True)
    th.start()
    yield


app = FastAPI(title="快传-服务端", lifespan=_app_lifespan)


def _client_host(request: Request) -> str:
    c = request.client
    return (c.host if c else "") or ""


def _is_local_host(host: str) -> bool:
    if host in ("127.0.0.1", "::1"):
        return True
    if host.startswith("::ffff:127.0.0.1"):
        return True
    return False


def require_localhost(request: Request) -> None:
    """仅允许从本机（回环地址）访问，用于管理端与危险操作。"""
    if not _is_local_host(_client_host(request)):
        raise HTTPException(status_code=403, detail="仅本机可访问")


def _request_client_ip(request: Request) -> str:
    c = request.client
    return (c.host if c else None) or "—"


_MAC_CACHE: dict[str, tuple[str, float]] = {}
_MAC_CACHE_TTL = 5.0


def _normalize_client_ipv4(ip: str) -> Optional[str]:
    """将 WebSocket / Request 中的 host 规范为纯 IPv4 字符串，便于查 ARP。"""
    s = (ip or "").strip()
    if not s or s in ("—", "-"):
        return None
    if s.startswith("::ffff:"):
        s = s[7:]
    if "%" in s:
        s = s.split("%", 1)[0]
    parts = s.split(".")
    if len(parts) != 4:
        return None
    try:
        nums = [int(p) for p in parts]
    except ValueError:
        return None
    if any(n < 0 or n > 255 for n in nums):
        return None
    return ".".join(str(n) for n in nums)


def _lookup_mac_linux_proc(ip: str) -> Optional[str]:
    """读取 Linux /proc/net/arp；无匹配行返回 None（可再试 ip neigh / arp）。"""
    p = Path("/proc/net/arp")
    if not p.is_file():
        return None
    try:
        text = p.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return None
    needle = ip.lower()
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 4:
            continue
        if parts[0].lower() != needle:
            continue
        mac = parts[3].strip().lower()
        if not mac or mac == "00:00:00:00:00:00":
            return ""
        if mac == "incomplete":
            return ""
        if re.fullmatch(r"([0-9a-f]{1,2}:){5}[0-9a-f]{1,2}", mac):
            return mac
        return ""
    return None


def _lookup_mac_ip_neigh(ip: str) -> Optional[str]:
    try:
        proc = subprocess.run(
            ["ip", "neigh", "show", ip],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
            **_win_hide_console_subprocess_kw(),
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired, subprocess.SubprocessError):
        return None
    out = proc.stdout or ""
    m = re.search(r"lladdr\s+((?:[0-9a-f]{1,2}:){5}[0-9a-f]{1,2})\b", out, re.I)
    if m:
        return m.group(1).lower()
    return None


def _lookup_mac_arp_command(ip: str) -> Optional[str]:
    """macOS / Windows / 其他系统的 arp 输出解析。"""
    sysname = platform.system()
    try:
        if sysname == "Windows":
            proc = subprocess.run(
                ["arp", "-a", ip],
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
                **_win_hide_console_subprocess_kw(),
            )
            out = proc.stdout or ""
            for line in out.splitlines():
                if ip not in line:
                    continue
                m = re.search(r"((?:[0-9a-fA-F]{2}[-]){5}[0-9a-fA-F]{2})", line)
                if m:
                    return m.group(1).replace("-", ":").lower()
            return ""
        proc = subprocess.run(
            ["arp", "-n", ip],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
            **_win_hide_console_subprocess_kw(),
        )
        out = (proc.stdout or "") + (proc.stderr or "")
        if "incomplete" in out.lower():
            return ""
        m = re.search(r" at\s+((?:[0-9a-fA-F]{1,2}:){5}[0-9a-fA-F]{1,2})\s", out)
        if m:
            return m.group(1).lower()
        m = re.search(r"\(([0-9a-fA-F:.]+)\)\s+at\s+((?:[0-9a-fA-F]{1,2}:){5}[0-9a-fA-F]{1,2})\s", out)
        if m:
            return m.group(2).lower()
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired, subprocess.SubprocessError):
        return None
    return None


def _lookup_mac_for_ip(ip: str) -> str:
    """根据 IPv4 在本机邻居/ARP 表中解析 MAC；无表项或本机环回则返回空串。"""
    norm = _normalize_client_ipv4(ip)
    if not norm or norm.startswith("127."):
        return ""
    r = _lookup_mac_linux_proc(norm)
    if r is not None:
        return r
    r2 = _lookup_mac_ip_neigh(norm)
    if r2:
        return r2
    r3 = _lookup_mac_arp_command(norm)
    if r3 is not None:
        return r3
    return ""


def _mac_for_ip_cached(ip: str) -> str:
    """在线列表展示用：按 IP 短时缓存，减轻 ARP 查询频率。"""
    norm = _normalize_client_ipv4(ip or "")
    if not norm or norm.startswith("127."):
        return "—"
    now = time.monotonic()
    hit = _MAC_CACHE.get(norm)
    if hit and now - hit[1] < _MAC_CACHE_TTL:
        return hit[0]
    raw = _lookup_mac_for_ip(norm)
    disp = raw if raw else "—"
    _MAC_CACHE[norm] = (disp, now)
    return disp


def _mac_cache_invalidate_ip(ip: str) -> None:
    """新连接时清掉该 IP 的 MAC 展示缓存，便于立刻从 ARP 读到新条目。"""
    norm = _normalize_client_ipv4(ip or "")
    if norm:
        _MAC_CACHE.pop(norm, None)


def _op_log(message: str, request: Request) -> None:
    """重要操作写入终端（含请求方 IP），不经过 HTTP 访问日志。"""
    print(f"[{_request_client_ip(request)}] {message}", flush=True)


_DEVICE_ALIAS_FILE = DATA_DIR / "device_aliases.json"
_DEVICE_ALIAS_LOCK = threading.RLock()
_BROWSER_TO_CANONICAL: dict[str, str] = {}


def _load_device_aliases() -> None:
    """启动时加载：浏览器端随机 id -> 局域网 MAC 主键（m_ 前缀）。"""
    global _BROWSER_TO_CANONICAL
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not _DEVICE_ALIAS_FILE.is_file():
        _BROWSER_TO_CANONICAL = {}
        return
    try:
        raw = json.loads(_DEVICE_ALIAS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        _BROWSER_TO_CANONICAL = {}
        return
    if isinstance(raw, dict):
        _BROWSER_TO_CANONICAL = {str(k): str(v) for k, v in raw.items() if isinstance(k, str) and isinstance(v, str)}
    else:
        _BROWSER_TO_CANONICAL = {}


def _save_device_aliases() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _DEVICE_ALIAS_LOCK:
        snap = dict(_BROWSER_TO_CANONICAL)
    _DEVICE_ALIAS_FILE.write_text(json.dumps(snap, ensure_ascii=False, indent=2), encoding="utf-8")


def _register_browser_to_mac_canonical(browser_id: str, canonical: str) -> None:
    """同一物理机（MAC）多次出现的浏览器随机 id 映射到稳定主键 m_<12hex>。"""
    browser_id = (browser_id or "").strip()
    canonical = (canonical or "").strip()
    if not browser_id or not canonical or browser_id == canonical:
        return
    if not canonical.startswith("m_"):
        return
    changed = False
    with _DEVICE_ALIAS_LOCK:
        if _BROWSER_TO_CANONICAL.get(browser_id) != canonical:
            _BROWSER_TO_CANONICAL[browser_id] = canonical
            changed = True
    if changed:
        _save_device_aliases()


def _all_equivalent_ids(node_id: str) -> set[str]:
    """与 node_id 视为同一端点的所有 client_id（含主键与曾用浏览器 id）。"""
    nid = (node_id or "").strip()
    out: set[str] = set()
    if not nid:
        return out
    out.add(nid)
    with _DEVICE_ALIAS_LOCK:
        if nid.startswith("m_"):
            canon = nid
        else:
            canon = _BROWSER_TO_CANONICAL.get(nid, nid)
        out.add(canon)
        for b, c in _BROWSER_TO_CANONICAL.items():
            if c == canon:
                out.add(b)
                out.add(c)
    return out


def _canonical_peer_id(cid: str) -> str:
    """将仍使用旧浏览器 id 的收/发件人解析为当前主键（若有映射）。"""
    c = (cid or "").strip()
    if not c:
        return c
    with _DEVICE_ALIAS_LOCK:
        return _BROWSER_TO_CANONICAL.get(c, c)


def _normalize_client_ids_in_record(rec: dict[str, Any]) -> dict[str, Any]:
    """写库或下发历史前统一 id，使私聊与会话列表与 MAC 主键一致。"""
    out = dict(rec)
    for key in ("sender_client_id", "to_client_id", "from_client_id"):
        if key not in out or not out[key]:
            continue
        v = str(out[key]).strip()
        if not v:
            continue
        out[key] = _canonical_peer_id(v)
    return out


def _local_date_key_from_file_mtime(st_mtime: float) -> str:
    """上传文件 mtime 对应服务端本地日历日。"""
    return datetime.fromtimestamp(st_mtime).date().isoformat()


def _parse_ymd_boundary(s: str) -> Optional[str]:
    s2 = (s or "").strip()[:10]
    if len(s2) != 10:
        return None
    try:
        date.fromisoformat(s2)
    except ValueError:
        return None
    return s2


def _ymd_range_pair(start: str, end: str) -> tuple[str, str]:
    lo = _parse_ymd_boundary(start)
    hi = _parse_ymd_boundary(end)
    if not lo or not hi:
        raise ValueError("start 与 end 需为 YYYY-MM-DD")
    if lo > hi:
        return hi, lo
    return lo, hi


def _history_item_with_file_missing(norm: dict[str, Any]) -> dict[str, Any]:
    """下发历史时：若 uploads 中已无对应文件，标记 file_missing 供前端占位（与仅清文件、未清聊天记录一致）。"""
    out = dict(norm)
    if out.get("type") != "file":
        return out
    sn = (out.get("stored_name") or "").strip()
    if not sn:
        out["file_missing"] = True
        return out
    path = (UPLOAD_DIR / Path(sn).name).resolve()
    if not str(path).startswith(str(UPLOAD_DIR.resolve())):
        out["file_missing"] = True
        return out
    out["file_missing"] = not path.is_file()
    return out


def _effective_session_client_id(browser_id: str, ip: str) -> tuple[str, str]:
    """WebSocket 会话主键：能解析出局域网 MAC 时用 m_<12hex>，否则沿用浏览器 id。"""
    bid = (browser_id or "").strip() or str(uuid.uuid4())
    norm_ip = _normalize_client_ipv4(ip or "") or ""
    mac_raw = ""
    if norm_ip and not norm_ip.startswith("127."):
        mac_raw = _lookup_mac_for_ip(norm_ip)
    if mac_raw and re.fullmatch(r"([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}", mac_raw.lower()):
        canon = "m_" + mac_raw.replace(":", "").lower()
        _register_browser_to_mac_canonical(bid, canon)
        return canon, "mac"
    return bid, "browser"


_load_device_aliases()


def chat_append_record(rec: dict[str, Any]) -> None:
    """追加一条聊天记录（JSON Lines）。"""
    row = _normalize_client_ids_in_record(dict(rec))
    if "id" not in row:
        row["id"] = uuid.uuid4().hex
    line = json.dumps(row, ensure_ascii=False) + "\n"
    with _CHAT_LOG_LOCK:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with CHAT_LOG.open("a", encoding="utf-8") as f:
            f.write(line)


def chat_load_for_client(client_id: str) -> list[dict[str, Any]]:
    """读取与某 client_id 相关的历史（群 + 与其相关的私聊）；合并曾用浏览器 id 与 MAC 主键。"""
    ids = _all_equivalent_ids(client_id)
    if not CHAT_LOG.is_file():
        return []
    rows: list[dict[str, Any]] = []
    with _CHAT_LOG_LOCK:
        try:
            text = CHAT_LOG.read_text(encoding="utf-8")
        except OSError:
            return []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        t = rec.get("type")
        if t == "text":
            to_c = (rec.get("to_client_id") or "").strip()
            scope = str(rec.get("scope", "")).strip().lower()
            is_group = (not to_c) or to_c == "__group__" or scope == "group"
            if is_group:
                rows.append(_history_item_with_file_missing(_normalize_client_ids_in_record(rec)))
                continue
            s = (rec.get("sender_client_id") or "").strip()
            if s in ids or to_c in ids:
                rows.append(_history_item_with_file_missing(_normalize_client_ids_in_record(rec)))
        elif t == "file":
            to_c = (rec.get("to_client_id") or "").strip()
            if not to_c:
                rows.append(_history_item_with_file_missing(_normalize_client_ids_in_record(rec)))
                continue
            fc = (rec.get("from_client_id") or "").strip()
            if fc in ids or to_c in ids:
                rows.append(_history_item_with_file_missing(_normalize_client_ids_in_record(rec)))
        elif t == "revoke":
            to_c = (rec.get("to_client_id") or "").strip()
            scope = str(rec.get("scope", "")).strip().lower()
            is_group = (not to_c) or to_c == "__group__" or scope == "group"
            if is_group:
                rows.append(_history_item_with_file_missing(_normalize_client_ids_in_record(rec)))
                continue
            s = (rec.get("sender_client_id") or "").strip()
            if s in ids or to_c in ids:
                rows.append(_history_item_with_file_missing(_normalize_client_ids_in_record(rec)))
    rows.sort(key=lambda r: str(r.get("ts") or ""))
    return rows


def chat_find_record_by_id(msg_id: str) -> Optional[dict[str, Any]]:
    if not msg_id or not CHAT_LOG.is_file():
        return None
    with _CHAT_LOG_LOCK:
        try:
            text = CHAT_LOG.read_text(encoding="utf-8")
        except OSError:
            return None
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        if str(rec.get("id") or "").strip() == msg_id:
            return _normalize_client_ids_in_record(rec)
    return None


def chat_clear_all() -> None:
    with _CHAT_LOG_LOCK:
        if CHAT_LOG.exists():
            CHAT_LOG.unlink(missing_ok=True)


class OnlineRegistry:
    """线程安全：记录当前 WebSocket 在线端（按 client_id 去重，同 id 新连接会顶掉旧连接）。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sessions: dict[str, dict[str, Any]] = {}
        self._ws_to_cid: dict[int, str] = {}

    async def bind(self, ws: WebSocket, client_id: str, nick: str, ip: str, ua: str) -> None:
        old_ws: Optional[WebSocket] = None
        with self._lock:
            prev = self._sessions.get(client_id)
            if prev and prev.get("ws") is not ws:
                old_ws = prev.get("ws")
        if old_ws is not None:
            with self._lock:
                self._ws_to_cid.pop(id(old_ws), None)
            try:
                await old_ws.close(code=4000)
            except Exception:
                pass
        with self._lock:
            self._sessions[client_id] = {
                "client_id": client_id,
                "nick": nick,
                "ip": ip or "—",
                "user_agent": (ua or "")[:160],
                "connected_at": datetime.now(timezone.utc).isoformat(),
                "ws": ws,
            }
            self._ws_to_cid[id(ws)] = client_id

    def unbind(self, ws: WebSocket) -> None:
        with self._lock:
            cid = self._ws_to_cid.pop(id(ws), None)
            if not cid:
                return
            sess = self._sessions.get(cid)
            if sess and sess.get("ws") is ws:
                del self._sessions[cid]

    def update_nick(self, ws: WebSocket, nick: str) -> None:
        nick = (nick or "").strip() or "匿名"
        with self._lock:
            cid = self._ws_to_cid.get(id(ws))
            if not cid:
                return
            sess = self._sessions.get(cid)
            if sess and sess.get("ws") is ws:
                sess["nick"] = nick

    def client_id_for(self, ws: WebSocket) -> Optional[str]:
        with self._lock:
            return self._ws_to_cid.get(id(ws))

    def reconcile_sessions_to_mac_keys(self) -> list[WebSocket]:
        """把已能解析出 MAC 的会话统一切到 m_<mac>；同一 MAC 多条连接时保留 connected_at 较新的一条，其余关闭。

        解决：ARP 稍晚就绪时首次连接仍用浏览器 id，导致同一物理机出现多行在线用户。
        """
        to_close: list[WebSocket] = []
        with self._lock:
            items = [(cid, s) for cid, s in self._sessions.items() if not str(cid).startswith("m_")]
            items.sort(key=lambda x: str(x[1].get("connected_at") or ""))
            for old_cid, sess in items:
                ws = sess.get("ws")
                if ws is None:
                    continue
                nip = _normalize_client_ipv4(str(sess.get("ip") or "")) or ""
                if not nip or nip.startswith("127."):
                    continue
                mac = _lookup_mac_for_ip(nip)
                if not mac or not re.fullmatch(r"([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}", mac.lower()):
                    continue
                canon = "m_" + mac.replace(":", "").lower()
                if canon == old_cid:
                    continue
                cur = self._sessions.get(old_cid)
                if not cur or cur.get("ws") is not ws:
                    continue
                existing = self._sessions.get(canon)
                if existing and existing.get("ws") is not ws:
                    dup_ws = existing.get("ws")
                    del self._sessions[canon]
                    if dup_ws:
                        self._ws_to_cid.pop(id(dup_ws), None)
                        to_close.append(dup_ws)
                del self._sessions[old_cid]
                self._ws_to_cid.pop(id(ws), None)
                sess["client_id"] = canon
                self._sessions[canon] = sess
                self._ws_to_cid[id(ws)] = canon
                _register_browser_to_mac_canonical(old_cid, canon)
        return to_close

    def find_client_meta_by_normalized_ip(self, nip: str) -> tuple[str, str]:
        """返回 (client_id, nick)；无在线连接时 ("", "")。"""
        with self._lock:
            for cid, s in self._sessions.items():
                if _normalize_client_ipv4(str(s.get("ip") or "")) == nip:
                    return cid, str(s.get("nick") or "")
        return "", ""

    def list_public(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = []
            for cid, s in self._sessions.items():
                equiv = _all_equivalent_ids(cid)
                aliases = sorted(e for e in equiv if e != cid)
                rows.append(
                    {
                        "client_id": cid,
                        "nick": s["nick"],
                        "ip": s["ip"],
                        "mac": _mac_for_ip_cached(str(s.get("ip") or "")),
                        "aliases": aliases,
                        "connected_at": s["connected_at"],
                        "user_agent": s.get("user_agent", ""),
                        "online": True,
                    }
                )
            rows.sort(key=lambda r: r["connected_at"])
            return rows

    def websocket_for_client_id(self, client_id: str) -> Optional[WebSocket]:
        with self._lock:
            sess = self._sessions.get(client_id)
            if not sess:
                return None
            return sess.get("ws")


online_registry = OnlineRegistry()


def _ws_for_cid(cid: str) -> Optional[WebSocket]:
    """按主键或曾用浏览器 id 查找当前 WebSocket。"""
    c = (cid or "").strip()
    if not c:
        return None
    w = online_registry.websocket_for_client_id(c)
    if w is not None:
        return w
    alt = _canonical_peer_id(c)
    if alt != c:
        return online_registry.websocket_for_client_id(alt)
    return None


class ConnectionManager:
    def __init__(self) -> None:
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._clients.discard(ws)

    async def broadcast_json(self, payload: dict[str, Any]) -> None:
        data = json.dumps(payload, ensure_ascii=False)
        async with self._lock:
            dead: list[WebSocket] = []
            for client in self._clients:
                try:
                    await client.send_text(data)
                except Exception:
                    dead.append(client)
            for c in dead:
                self._clients.discard(c)

    async def send_json_to_websockets(self, websockets: list[WebSocket], payload: dict[str, Any]) -> None:
        """仅向指定连接推送（用于私聊文本/文件）。"""
        data = json.dumps(payload, ensure_ascii=False)
        seen: set[int] = set()
        async with self._lock:
            dead: list[WebSocket] = []
            for ws in websockets:
                if ws is None:
                    continue
                wid = id(ws)
                if wid in seen:
                    continue
                seen.add(wid)
                try:
                    await ws.send_text(data)
                except Exception:
                    dead.append(ws)
            for c in dead:
                self._clients.discard(c)


manager = ConnectionManager()


def _safe_stem(name: str) -> str:
    base = Path(name).name
    return base if base else "unnamed"


def _original_download_name(stored_name: str) -> str:
    """存储名为 {uuid32}_{原始文件名}，下载时尽量还原原始文件名。"""
    if len(stored_name) > 33 and stored_name[32] == "_":
        prefix, rest = stored_name[:32].lower(), stored_name[33:]
        if len(prefix) == 32 and all(c in "0123456789abcdef" for c in prefix) and rest:
            return rest
    return stored_name


def _list_uploads() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for p in sorted(UPLOAD_DIR.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        if not p.is_file():
            continue
        st = p.stat()
        items.append(
            {
                "stored_name": p.name,
                "size": st.st_size,
                "modified": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
            }
        )
    return items


def _admin_upload_list_entries(filter_lo: Optional[str] = None, filter_hi: Optional[str] = None) -> list[dict[str, Any]]:
    """管理端上传列表；可选按服务端本地日历日 [filter_lo, filter_hi] 筛选。"""
    out: list[dict[str, Any]] = []
    if not UPLOAD_DIR.is_dir():
        return out
    for p in sorted(UPLOAD_DIR.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
        if not p.is_file():
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        dk = _local_date_key_from_file_mtime(st.st_mtime)
        if filter_lo is not None and filter_hi is not None:
            if not (filter_lo <= dk <= filter_hi):
                continue
        out.append(
            {
                "stored_name": p.name,
                "display_name": _original_download_name(p.name),
                "size": st.st_size,
                "modified": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
                "local_date": dk,
            }
        )
    return out


def uploads_purge_by_local_date_range(lo: str, hi: str) -> list[str]:
    """删除 mtime 落在 [lo, hi]（含）内的上传文件，返回已删除的 stored_name。"""
    removed: list[str] = []
    if not UPLOAD_DIR.is_dir():
        return removed
    for p in UPLOAD_DIR.iterdir():
        if not p.is_file():
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        dk = _local_date_key_from_file_mtime(st.st_mtime)
        if lo <= dk <= hi:
            try:
                p.unlink(missing_ok=True)
                removed.append(p.name)
            except OSError:
                pass
    return removed


# 与前端 GROUP_ID 一致
_GROUP_CHAT_ID = "__lan_group__"


def _list_files_for_chat(chat_id: str, viewer_client_id: str) -> list[dict[str, Any]]:
    """按聊天记录筛选某会话出现过的上传文件（且文件仍在 uploads）。"""
    viewer_ids = _all_equivalent_ids(viewer_client_id)
    chat_ids = _all_equivalent_ids(chat_id) if chat_id != _GROUP_CHAT_ID else {_GROUP_CHAT_ID}
    if not CHAT_LOG.is_file():
        return []
    try:
        with _CHAT_LOG_LOCK:
            text = CHAT_LOG.read_text(encoding="utf-8")
    except OSError:
        return []
    hits: list[tuple[str, str]] = []  # (ts_iso, stored_name)
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict) or rec.get("type") != "file":
            continue
        to_c = (rec.get("to_client_id") or "").strip()
        fc = (rec.get("from_client_id") or "").strip()
        ok = False
        if chat_id == _GROUP_CHAT_ID:
            ok = not to_c
        else:
            if fc and to_c:
                ok = (fc in viewer_ids and to_c in chat_ids) or (fc in chat_ids and to_c in viewer_ids)
        if not ok:
            continue
        sn = (rec.get("stored_name") or "").strip()
        if not sn:
            continue
        ts = str(rec.get("ts") or "")
        hits.append((ts, sn))
    hits.sort(key=lambda x: x[0], reverse=True)
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for _ts, sn in hits:
        if sn in seen:
            continue
        seen.add(sn)
        path = UPLOAD_DIR / sn
        if not path.is_file():
            continue
        st = path.stat()
        out.append(
            {
                "stored_name": sn,
                "size": st.st_size,
                "modified": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
            }
        )
    return out


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/app/version")
def api_app_version() -> dict[str, str]:
    """当前服务版本（与 GitHub Release 对照）。"""
    return {"version": get_version()}


@app.get("/api/update/check")
def api_update_check(request: Request) -> dict[str, Any]:
    """检查 GitHub 最新 Release（仅本机可调；供控制台检测桌面端升级，避免局域网用户端重复请求）。"""
    require_localhost(request)
    from updater import check_for_updates

    info = check_for_updates()
    if info is None:
        return {
            "success": False,
            "has_update": False,
            "current_version": get_version(),
            "latest_version": "",
            "release_notes": "",
            "download_url": "",
            "release_url": "",
        }
    return {
        "success": True,
        "has_update": info.has_update,
        "current_version": info.current_version,
        "latest_version": info.latest_version,
        "release_notes": info.release_notes,
        "download_url": info.download_url,
        "release_url": info.release_url,
    }


@app.get("/api/lan-host")
def api_lan_host() -> dict[str, str]:
    """浏览器端统一展示的局域网服务 IPv4（取本机检测到的第一个非回环地址）。"""
    ips = _get_lan_ips()
    return {"ip": ips[0] if ips else ""}


@app.get("/api/lan/mac-for-ip")
def api_lan_mac_for_ip(ip: str = Query(..., description="局域网对端 IPv4")) -> dict[str, Any]:
    """由服务端根据本机 ARP/邻居表解析某 IPv4 的 MAC（浏览器无法直接读取 MAC 时可用此接口）。"""
    nip = _normalize_client_ipv4(ip)
    if not nip:
        raise HTTPException(status_code=400, detail="无效的 IPv4 地址")
    _mac_cache_invalidate_ip(nip)
    mac = _lookup_mac_for_ip(nip)
    cid, nn = online_registry.find_client_meta_by_normalized_ip(nip)
    return {"ip": nip, "mac": mac or "", "client_id": cid, "nick": nn}


def _suggest_nick_from_user_agent(ua: str) -> str:
    """根据 User-Agent 推断浏览器端设备类型，作默认昵称（无法拿到真实计算机名）。"""
    u = (ua or "").lower()
    if "iphone" in u:
        return "iPhone"
    if "ipad" in u:
        return "iPad"
    if "android" in u:
        return "Android 设备"
    if "windows nt" in u or "windows phone" in u:
        return "Windows 电脑"
    if "mac os x" in u or "macintosh" in u:
        return "Mac"
    if "linux" in u:
        return "Linux 设备"
    return "本设备"


@app.get("/api/suggest-nick")
def suggest_nick(request: Request) -> dict[str, str]:
    ua = request.headers.get("user-agent", "")
    return {"nick": _suggest_nick_from_user_agent(ua)}


@app.get("/api/online")
async def api_online() -> dict[str, Any]:
    """当前通过 WebSocket 保持连接的端列表；每次拉取前合并同一 MAC 的多余连接。"""
    for dup_ws in online_registry.reconcile_sessions_to_mac_keys():
        try:
            await dup_ws.close(code=4001)
        except Exception:
            pass
    return {"devices": online_registry.list_public()}


@app.get("/api/files")
def list_files(
    chat_id: Optional[str] = Query(None, description="当前会话：__lan_group__ 或私聊对方 client_id"),
    client_id: Optional[str] = Query(None, description="当前浏览器 client_id"),
) -> dict[str, Any]:
    """带 chat_id + client_id 时只返回该会话聊天记录中的文件；否则返回 uploads 全部（兼容未传参的调用）。"""
    cid = (chat_id or "").strip()
    vid = (client_id or "").strip()
    if cid and vid:
        return {"files": _list_files_for_chat(cid, vid)}
    return {"files": _list_uploads()}


@app.post("/api/upload")
async def upload_file(
    file: UploadFile = File(...),
    uploader: Optional[str] = Form(None),
    from_client_id: Optional[str] = Form(None),
    to_client_id: Optional[str] = Form(None),
) -> dict[str, Any]:
    raw = _safe_stem(file.filename or "")
    stored = f"{uuid.uuid4().hex}_{raw}"
    dest = UPLOAD_DIR / stored
    size = 0
    try:
        with dest.open("wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                out.write(chunk)
    except Exception:
        if dest.exists():
            dest.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail="保存文件失败")

    fc = _canonical_peer_id((from_client_id or "").strip())
    tc = _canonical_peer_id((to_client_id or "").strip())
    msg_id = uuid.uuid4().hex
    payload: dict[str, Any] = {
        "id": msg_id,
        "type": "file",
        "stored_name": stored,
        "original_name": raw,
        "size": size,
        "uploader": (uploader or "").strip() or "匿名",
        "ts": datetime.now(timezone.utc).isoformat(),
        "from_client_id": fc or None,
        "to_client_id": tc or None,
    }
    if tc:
        rws = _ws_for_cid(tc)
        sws = _ws_for_cid(fc) if fc else None
        targets: list[WebSocket] = []
        if sws is not None:
            targets.append(sws)
        if rws is not None and rws not in targets:
            targets.append(rws)
        if targets:
            await manager.send_json_to_websockets(targets, payload)
        else:
            await manager.broadcast_json(payload)
    else:
        await manager.broadcast_json(payload)
    chat_append_record(dict(payload))
    return payload


def _resolved_upload_file(stored_name: str) -> Path:
    path = (UPLOAD_DIR / Path(stored_name).name).resolve()
    if not str(path).startswith(str(UPLOAD_DIR.resolve())) or not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    return path


@app.get("/api/files/{stored_name}/download")
def download_file(stored_name: str) -> FileResponse:
    path = _resolved_upload_file(stored_name)
    dl_name = _original_download_name(path.name)
    return FileResponse(path, filename=dl_name, media_type="application/octet-stream")


@app.get("/api/files/{stored_name}/inline")
def view_file_inline(stored_name: str) -> FileResponse:
    """内联返回文件（用于聊天内图片/视频预览，Content-Disposition: inline）。"""
    path = _resolved_upload_file(stored_name)
    dl_name = _original_download_name(path.name)
    media_type, _ = mimetypes.guess_type(str(path))
    if not media_type:
        media_type = "application/octet-stream"
    return FileResponse(
        path,
        filename=dl_name,
        media_type=media_type,
        content_disposition_type="inline",
    )


def _remove_all_upload_files() -> int:
    """删除 uploads 目录下所有普通文件，返回删除个数。"""
    if not UPLOAD_DIR.is_dir():
        return 0
    removed = 0
    for p in UPLOAD_DIR.iterdir():
        if p.is_file():
            p.unlink(missing_ok=True)
            removed += 1
    return removed


def _read_upload_auto_purge_hours() -> float:
    """自动清理：保留最近 N 小时内修改过的上传；返回 0 表示关闭。配置见 data/upload_auto_purge.json。"""
    with _UPLOAD_AUTO_PURGE_FILE_LOCK:
        if not UPLOAD_AUTO_PURGE_SETTINGS.is_file():
            return 0.0
        try:
            raw = UPLOAD_AUTO_PURGE_SETTINGS.read_text(encoding="utf-8")
            data = json.loads(raw)
        except Exception:
            return 0.0
    if not isinstance(data, dict):
        return 0.0
    try:
        h = float(data.get("upload_auto_purge_hours", 0))
    except (TypeError, ValueError):
        return 0.0
    if h <= 0:
        return 0.0
    if h > 8760 * 2:
        return 0.0
    return h


def _write_upload_auto_purge_hours(hours: float) -> None:
    """写入自动清理小时数；0 或负数按 0 存（关闭）。"""
    try:
        hv = float(hours)
    except (TypeError, ValueError):
        hv = 0.0
    if hv < 0:
        hv = 0.0
    if hv > 8760 * 2:
        hv = 8760 * 2
    body = json.dumps({"upload_auto_purge_hours": hv}, ensure_ascii=False, indent=2) + "\n"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _UPLOAD_AUTO_PURGE_FILE_LOCK:
        UPLOAD_AUTO_PURGE_SETTINGS.write_text(body, encoding="utf-8")


def _purge_stale_uploads_by_age_seconds(max_age_seconds: float) -> list[str]:
    """删除修改时间早于 now-max_age_seconds 的上传文件，返回已删 stored_name。"""
    removed: list[str] = []
    if max_age_seconds <= 0 or not UPLOAD_DIR.is_dir():
        return removed
    now = time.time()
    for p in UPLOAD_DIR.iterdir():
        if not p.is_file():
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        if now - st.st_mtime > max_age_seconds:
            try:
                p.unlink(missing_ok=True)
                removed.append(p.name)
            except OSError:
                pass
    return removed


def _schedule_broadcast_uploads_purged(removed: list[str]) -> None:
    """在 asyncio 主循环上广播 uploads_purged（供后台线程调用）。"""
    if not removed:
        return
    loop = _uvicorn_loop
    if loop is None or not loop.is_running():
        return

    async def _send() -> None:
        await manager.broadcast_json({"type": "uploads_purged", "stored_names": removed, "removed": len(removed)})

    try:
        asyncio.run_coroutine_threadsafe(_send(), loop)
    except Exception as exc:
        print(f"[upload-auto-purge] 广播失败: {exc}", flush=True)


def _upload_auto_purge_loop() -> None:
    """后台定时扫描：按配置删除过旧的上传文件。"""
    time.sleep(60)
    while True:
        try:
            hours = _read_upload_auto_purge_hours()
            if hours > 0:
                removed = _purge_stale_uploads_by_age_seconds(hours * 3600.0)
                if removed:
                    print(f"[upload-auto-purge] 已删除 {len(removed)} 个超过 {hours} 小时的文件", flush=True)
                    _schedule_broadcast_uploads_purged(removed)
        except Exception as exc:
            print(f"[upload-auto-purge] 异常: {exc}", flush=True)
        time.sleep(600)


@app.post("/api/clear")
async def clear_uploads(request: Request) -> dict[str, Any]:
    """清除服务端 uploads 目录下所有已上传文件（仅本机可调）。"""
    require_localhost(request)
    removed = _remove_all_upload_files()
    await manager.broadcast_json({"type": "cleared", "removed": removed})
    _op_log(f"已清除服务器全部上传文件，共删除 {removed} 个", request)
    return {"removed": removed}


@app.post("/api/admin/clear-chats")
async def admin_clear_chat_history(request: Request) -> dict[str, Any]:
    """清除所有持久化聊天记录，并删除 uploads 下全部已上传文件（仅本机可调）。"""
    require_localhost(request)
    chat_clear_all()
    removed = _remove_all_upload_files()
    await manager.broadcast_json({"type": "cleared", "removed": removed})
    await manager.broadcast_json({"type": "chat_history_cleared"})
    _op_log(f"已清除全部持久化聊天记录，并删除全部上传文件（共 {removed} 个）", request)
    return {"ok": True, "removed_uploads": removed}


@app.get("/api/admin/uploads")
def api_admin_uploads_list(
    request: Request,
    start: str | None = None,
    end: str | None = None,
) -> dict[str, Any]:
    """列出 uploads（仅本机）；可选 start、end（YYYY-MM-DD）按服务端本地日历日筛选。"""
    require_localhost(request)
    if (start and not end) or (end and not start):
        raise HTTPException(status_code=400, detail="筛选时请同时提供 start 与 end（YYYY-MM-DD）")
    if start and end:
        lo, hi = _ymd_range_pair(start, end)
        files = _admin_upload_list_entries(lo, hi)
    else:
        files = _admin_upload_list_entries(None, None)
    return {"files": files, "count": len(files)}


@app.post("/api/admin/uploads/purge-by-date")
async def admin_uploads_purge_by_date(request: Request) -> dict[str, Any]:
    """按服务端本地日历日范围删除 uploads 内文件（仅本机）。"""
    require_localhost(request)
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="需要 JSON 请求体")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="无效的请求体")
    try:
        lo, hi = _ymd_range_pair(str(data.get("start", "")), str(data.get("end", "")))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    removed_names = uploads_purge_by_local_date_range(lo, hi)
    await manager.broadcast_json({"type": "uploads_purged", "stored_names": removed_names, "removed": len(removed_names)})
    _op_log(f"按本地日期 {lo}～{hi} 清除上传文件，共删除 {len(removed_names)} 个", request)
    return {"removed": len(removed_names), "start": lo, "end": hi, "stored_names": removed_names}


@app.get("/api/admin/upload-auto-purge")
def admin_get_upload_auto_purge(request: Request) -> dict[str, Any]:
    """读取上传自动清理配置：hours>0 表示删除「修改时间」早于该小时数的文件（仅本机）。"""
    require_localhost(request)
    return {"hours": _read_upload_auto_purge_hours()}


@app.post("/api/admin/upload-auto-purge")
async def admin_set_upload_auto_purge(request: Request) -> dict[str, Any]:
    """设置上传自动清理小时数；0 关闭（仅本机）。"""
    require_localhost(request)
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="需要 JSON 请求体")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="无效的请求体")
    try:
        hv = float(data.get("hours", 0))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="hours 须为数字")
    if hv < 0 or hv > 8760 * 2:
        raise HTTPException(status_code=400, detail="hours 须在 0～17520 之间")
    _write_upload_auto_purge_hours(hv)
    out = _read_upload_auto_purge_hours()
    _op_log(f"已设置上传自动清理：{out} 小时（0 为关闭，按文件修改时间）", request)
    return {"hours": out}


@app.get("/api/admin/server-info")
def admin_server_info(request: Request) -> dict[str, Any]:
    """返回局域网用户端端口与地址（仅本机可调，供管理页展示）。"""
    require_localhost(request)
    port = _server_port()
    lan_ips = _get_lan_ips()
    lan_user_urls = [f"http://{ip}:{port}/" for ip in lan_ips]
    return {
        "port": port,
        "lan_user_urls": lan_user_urls,
    }


@app.post("/api/admin/open-browser")
async def admin_open_browser(request: Request) -> dict[str, bool]:
    """在系统默认浏览器中打开 URL（仅本机；供控制台升级弹窗「前往下载」）。"""
    require_localhost(request)
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="需要 JSON 请求体")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="无效的请求体")
    url = str(data.get("url") or "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="缺少 url")
    parts = urlparse(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise HTTPException(status_code=400, detail="仅允许 http(s) 链接")
    from updater import open_download_page

    if not open_download_page(url):
        raise HTTPException(status_code=500, detail="无法在系统浏览器中打开链接")
    return {"ok": True}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    qp = websocket.query_params
    browser_id = (qp.get("client_id") or "").strip() or str(uuid.uuid4())
    nick = (qp.get("nick") or "").strip() or "匿名"
    ip = websocket.client.host if websocket.client else ""
    ua = websocket.headers.get("user-agent", "")

    await manager.connect(websocket)
    _mac_cache_invalidate_ip(ip)
    effective_id, id_source = _effective_session_client_id(browser_id, ip)
    await online_registry.bind(websocket, effective_id, nick, ip, ua)
    for dup_ws in online_registry.reconcile_sessions_to_mac_keys():
        if dup_ws is websocket:
            continue
        try:
            await dup_ws.close(code=4001)
        except Exception:
            pass
    actual_id = online_registry.client_id_for(websocket) or effective_id
    await manager.broadcast_json(
        {"type": "presence", "action": "sync", "devices": online_registry.list_public()}
    )
    try:
        hist = chat_load_for_client(actual_id)
        merged = sorted(_all_equivalent_ids(actual_id) - {actual_id})
        await websocket.send_text(
            json.dumps(
                {
                    "type": "history",
                    "client_id": actual_id,
                    "id_source": id_source,
                    "merged_client_ids": merged,
                    "items": hist,
                },
                ensure_ascii=False,
            )
        )
    except Exception:
        pass
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, dict):
                continue
            mtype = msg.get("type")
            if mtype == "join":
                n = str(msg.get("from", "")).strip() or nick
                online_registry.update_nick(websocket, n)
                await manager.broadcast_json(
                    {
                        "type": "presence",
                        "action": "update",
                        "devices": online_registry.list_public(),
                    }
                )
                continue
            if mtype == "revoke":
                target_id = str(msg.get("target_id") or "").strip()
                if not target_id:
                    continue
                sender_cid = online_registry.client_id_for(websocket)
                if not sender_cid:
                    continue
                target = chat_find_record_by_id(target_id)
                if not target:
                    await manager.send_json_to_websockets(
                        [websocket],
                        {"type": "error", "code": "revoke_not_found", "message": "未找到可撤回的消息。"},
                    )
                    continue
                ttype = str(target.get("type") or "").strip().lower()
                owner = ""
                to_cid = ""
                scope = ""
                if ttype == "text":
                    owner = str(target.get("sender_client_id") or "").strip()
                    to_cid = str(target.get("to_client_id") or "").strip()
                    scope = str(target.get("scope") or "").strip().lower()
                elif ttype == "file":
                    owner = str(target.get("from_client_id") or "").strip()
                    to_cid = str(target.get("to_client_id") or "").strip()
                    scope = "group" if not to_cid else ""
                else:
                    await manager.send_json_to_websockets(
                        [websocket],
                        {"type": "error", "code": "revoke_unsupported", "message": "该消息类型不支持撤回。"},
                    )
                    continue
                if owner != sender_cid:
                    await manager.send_json_to_websockets(
                        [websocket],
                        {"type": "error", "code": "revoke_forbidden", "message": "仅可撤回自己发送的消息。"},
                    )
                    continue
                out = {
                    "type": "message_revoked",
                    "target_id": target_id,
                    "sender_client_id": sender_cid,
                    "ts": datetime.now(timezone.utc).isoformat(),
                }
                is_group = (not to_cid) or to_cid == "__group__" or scope == "group"
                if is_group:
                    await manager.broadcast_json(out)
                else:
                    recipient_ws = _ws_for_cid(_canonical_peer_id(to_cid))
                    await manager.send_json_to_websockets([websocket, recipient_ws], out)
                chat_append_record(
                    {
                        "type": "revoke",
                        "target_id": target_id,
                        "sender_client_id": sender_cid,
                        "to_client_id": to_cid or None,
                        "scope": "group" if is_group else "",
                        "ts": out["ts"],
                    }
                )
                continue
            if mtype != "text":
                continue
            body = str(msg.get("body", "")).strip()
            if not body:
                continue
            nick_msg = str(msg.get("from", "")).strip() or "匿名"
            online_registry.update_nick(websocket, nick_msg)
            sender_cid = online_registry.client_id_for(websocket)
            to_cid = _canonical_peer_id(str(msg.get("to_client_id", "")).strip())
            scope_raw = str(msg.get("scope", "")).strip().lower()
            is_group = (not to_cid) or to_cid == "__group__" or scope_raw == "group"
            if is_group:
                out = {
                    "id": uuid.uuid4().hex,
                    "type": "text",
                    "from": nick_msg,
                    "body": body,
                    "ts": datetime.now(timezone.utc).isoformat(),
                    "sender_client_id": sender_cid,
                    "scope": "group",
                    "to_client_id": None,
                }
                chat_append_record(dict(out))
                await manager.broadcast_json(out)
                continue
            if sender_cid and to_cid == sender_cid:
                await manager.send_json_to_websockets(
                    [websocket],
                    {"type": "error", "code": "self", "message": "不能给自己发私聊。"},
                )
                continue
            recipient_ws = _ws_for_cid(to_cid)
            if recipient_ws is None:
                await manager.send_json_to_websockets(
                    [websocket],
                    {
                        "type": "error",
                        "code": "peer_offline",
                        "message": "对方不在线或未打开页面。",
                    },
                )
                continue
            out = {
                "id": uuid.uuid4().hex,
                "type": "text",
                "from": nick_msg,
                "body": body,
                "ts": datetime.now(timezone.utc).isoformat(),
                "sender_client_id": sender_cid,
                "to_client_id": to_cid,
            }
            chat_append_record(dict(out))
            await manager.send_json_to_websockets([websocket, recipient_ws], out)
    except WebSocketDisconnect:
        pass
    finally:
        online_registry.unbind(websocket)
        await manager.disconnect(websocket)
        try:
            await manager.broadcast_json(
                {"type": "presence", "action": "sync", "devices": online_registry.list_public()}
            )
        except Exception:
            pass


def _spa_index_path() -> Path:
    return SPA_DIR / "index.html"


@app.get("/static/icon.png")
def site_icon_png() -> FileResponse:
    """站点图标（请将项目 static/icon.png 置于该路径）。"""
    p = STATIC_DIR / "icon.png"
    if not p.is_file():
        raise HTTPException(status_code=404, detail="未找到 static/icon.png")
    return FileResponse(p, media_type="image/png")


@app.get("/static/notification.mp3")
def site_notification_mp3() -> FileResponse:
    """新消息提示音（static/notification.mp3）。"""
    p = STATIC_DIR / "notification.mp3"
    if not p.is_file():
        raise HTTPException(status_code=404, detail="未找到 static/notification.mp3")
    return FileResponse(p, media_type="audio/mpeg")


@app.get("/manifest.webmanifest")
def site_web_manifest() -> FileResponse:
    """PWA 清单：用于 Safari/浏览器添加到桌面或 Dock。"""
    p = SPA_DIR / "manifest.webmanifest"
    if not p.is_file():
        raise HTTPException(status_code=404, detail="未找到 manifest.webmanifest，请先构建前端")
    return FileResponse(p, media_type="application/manifest+json")


@app.get("/")
def index_page() -> FileResponse:
    idx = _spa_index_path()
    if not idx.is_file():
        raise HTTPException(
            status_code=503,
            detail="Web 界面未构建：请在项目 frontend 目录执行 npm install && npm run build",
        )
    return FileResponse(idx, media_type="text/html; charset=utf-8")


@app.get("/admin")
@app.get("/admin/")
def admin_console_page(request: Request) -> FileResponse:
    """控制台（仅回环地址可打开页面）。"""
    require_localhost(request)
    admin_html = SPA_DIR / "admin.html"
    if not admin_html.is_file():
        raise HTTPException(
            status_code=503,
            detail="管理端未构建：请在 frontend 目录执行 npm run build",
        )
    return FileResponse(admin_html, media_type="text/html; charset=utf-8")


_assets_dir = SPA_DIR / "assets"
if _assets_dir.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_assets_dir)), name="spa-assets")


def _outbound_ipv4() -> Optional[str]:
    """通过选择默认出站网卡推断本机 IPv4（不发送真实数据）。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip and not ip.startswith("127."):
                return ip
        finally:
            s.close()
    except OSError:
        pass
    return None


def _get_lan_ips() -> list[str]:
    ips: list[str] = []
    outbound = _outbound_ipv4()
    if outbound:
        ips.append(outbound)
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, family=socket.AF_INET):
            addr = info[4][0]
            if addr and not addr.startswith("127."):
                ips.append(addr)
        for addr in socket.gethostbyname_ex(hostname)[2]:
            if addr and not addr.startswith("127."):
                ips.append(addr)
    except OSError:
        pass
    return list(dict.fromkeys(ips))


def _print_startup_info(port: int) -> None:
    lan_ips = _get_lan_ips()
    print(f"服务已启动: http://127.0.0.1:{port}", flush=True)
    print(f"控制台（仅回环）: http://127.0.0.1:{port}/admin", flush=True)
    print("当前设备的内网 IP：", flush=True)
    if lan_ips:
        for ip in lan_ips:
            print(f"  {ip}  ->  http://{ip}:{port}", flush=True)
    else:
        print("  （未能自动检测，请在系统网络设置中查看本机 IPv4）", flush=True)


def _has_windows_console() -> bool:
    """Windows 下判断当前进程是否已附着控制台。"""
    if sys.platform != "win32":
        return True
    try:
        import ctypes

        return bool(ctypes.windll.kernel32.GetConsoleWindow())
    except Exception:
        return False


def _open_admin_in_browser_when_ready(port: int) -> None:
    """等待本机服务就绪后，自动在默认浏览器打开 /admin。"""

    def _worker() -> None:
        if _wait_health_local(port, timeout=20.0):
            url = f"http://127.0.0.1:{port}/admin/"
            try:
                webbrowser.open(url, new=1)
            except Exception as exc:
                print(f"自动打开浏览器失败：{exc}", flush=True)

    th = threading.Thread(target=_worker, name="open-admin-browser", daemon=True)
    th.start()


def _spawn_windows_fallback_console_hint(port: int) -> None:
    """
    WebView 失败时，在 Windows 弹出提示终端窗口，显示运行地址与说明。
    仅在当前进程无控制台时触发，避免重复弹窗。
    """
    if sys.platform != "win32" or _has_windows_console():
        return
    local = f"http://127.0.0.1:{port}"
    admin = f"{local}/admin"
    cmd = (
        "title LAN Transfer Fallback && "
        "echo WebView 启动失败，已自动回退到仅控制台服务模式。 && "
        f"echo 主站地址: {local} && "
        f"echo 管理后台: {admin} && "
        "echo 已尝试自动打开后台页面。 && "
        "echo 可按 Ctrl+C 终止服务。"
    )
    try:
        subprocess.Popen(
            ["cmd.exe", "/k", cmd],
            creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
        )
    except Exception as exc:
        print(f"弹出回退终端失败：{exc}", flush=True)


def _wait_health_local(port: int, timeout: float = 20.0) -> bool:
    """等待本机 HTTP 服务可响应（避免 WebView 白屏）。"""
    import urllib.error
    import urllib.request

    url = f"http://127.0.0.1:{port}/api/health"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as resp:
                code = resp.getcode() if hasattr(resp, "getcode") else getattr(resp, "status", 0)
                if code == 200:
                    return True
        except (urllib.error.URLError, OSError, TimeoutError):
            time.sleep(0.08)
    return False


def _webview_icon_path() -> Optional[str]:
    """
    pywebview 在 macOS Cocoa / Windows 等后端可用的应用图标路径（绝对路径）。
    与参考项目 veo3free 类似：有图标文件时程序坞 / 任务栏显示自定义图标。
    """
    names = ("app_icon.icns", "icon.png", "app_icon.ico")
    roots: list[Path] = []
    if _is_frozen():
        roots.append(BUNDLE_ROOT)
        ep = Path(sys.executable).resolve().parent
        if ep not in roots:
            roots.append(ep)
    else:
        roots.append(Path(__file__).resolve().parent)
    for root in roots:
        for name in names:
            p = root / "icons" / name
            if p.is_file():
                return str(p.resolve())
    return None


def _use_webview_shell() -> bool:
    if os.environ.get("NO_WEBVIEW", "").strip().lower() in ("1", "true", "yes"):
        return False
    if "--no-webview" in sys.argv:
        return False
    try:
        import webview  # noqa: F401
    except ImportError:
        print("未安装 pywebview，已使用仅控制台模式。安装: pip install pywebview", flush=True)
        return False
    return True


def _run_with_webview() -> bool:
    """后台线程跑 Uvicorn，主线程跑 pywebview 打开 /admin。成功返回 True；失败时返回 False 供回退。"""
    import uvicorn
    import webview

    if sys.platform == "win32":
        os.environ.setdefault("PYWEBVIEW_BACKEND", "edgechromium")

    port = _server_port()
    host = os.environ.get("HOST", "0.0.0.0")
    config = uvicorn.Config(
        app,
        host=host,
        port=port,
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)

    def _serve() -> None:
        server.run()

    th = threading.Thread(target=_serve, daemon=True)
    th.start()
    if not _wait_health_local(port):
        print("错误：本机服务在超时时间内未就绪，请检查端口是否被占用。", flush=True)
        server.should_exit = True
        th.join(timeout=5)
        return False

    _print_startup_info(port)
    admin_url = f"http://127.0.0.1:{port}/admin/"
    print(f"正在打开控制台窗口（WebView）: {admin_url}", flush=True)

    icon_path = _webview_icon_path()
    if not icon_path:
        print("提示：未找到 icons/app_icon.icns（可先运行 python create_icon.py），程序坞可能显示 Python 默认图标。", flush=True)

    try:
        webview.create_window(
            "控制台",
            admin_url,
            width=1024,
            height=720,
            min_size=(640, 480),
        )
    except Exception as exc:
        print(f"WebView 窗口创建失败，将回退为仅控制台模式：{exc}", flush=True)
        server.should_exit = True
        th.join(timeout=8)
        return False

    try:
        try:
            if icon_path:
                webview.start(icon=icon_path)
            else:
                webview.start()
            return True
        except Exception as exc:
            print(f"WebView 启动失败，将回退为仅控制台模式：{exc}", flush=True)
            return False
    finally:
        server.should_exit = True
        th.join(timeout=8)


_version_status_lock = threading.RLock()
_version_status_snapshot: dict[str, Any] = {
    "current_version": "",
    "latest_version": "",
    "has_update": False,
    "check_ok": False,
    "message": "",
}


def _version_status_refresh_and_print() -> None:
    """查询 GitHub 最新版、更新内存快照，并在控制台打印一行版本栏。"""
    from updater import check_for_updates, os_env_dev

    cur = (get_version() or "").strip() or "—"
    if os_env_dev() or (cur or "").lower() in ("dev", "0.0.0-dev"):
        msg = f"【版本栏】当前 v{cur}  ·  未请求 GitHub（开发模式或 dev 版本）"
        with _version_status_lock:
            _version_status_snapshot.update(
                current_version=cur,
                latest_version="",
                has_update=False,
                check_ok=False,
                message=msg,
            )
        print(msg, flush=True)
        return

    info = check_for_updates()
    latest = (info.latest_version if info else "") or ""
    has_up = bool(info and info.has_update)
    ok = info is not None

    if ok and latest:
        if has_up:
            tail = "有新版本可升级"
        else:
            tail = "已是最新"
        msg = f"【版本栏】当前 v{cur}  ·  GitHub 最新 v{latest}  ·  {tail}"
    elif ok:
        msg = f"【版本栏】当前 v{cur}  ·  GitHub 无版本号  ·  请核对 Release"
    else:
        msg = f"【版本栏】当前 v{cur}  ·  未能获取 GitHub 最新版本（网络或未发版）"

    with _version_status_lock:
        _version_status_snapshot.update(
            current_version=cur,
            latest_version=latest,
            has_update=has_up,
            check_ok=ok,
            message=msg,
        )
    print(msg, flush=True)


def _version_status_bar_loop() -> None:
    """后台定时刷新版本栏（避免阻塞主线程）。"""
    time.sleep(3.0)
    while True:
        try:
            _version_status_refresh_and_print()
        except Exception as exc:
            line = f"【版本栏】刷新失败: {exc}"
            print(line, flush=True)
            with _version_status_lock:
                _version_status_snapshot["message"] = line
        time.sleep(900.0)


def _start_version_status_bar_thread() -> None:
    th = threading.Thread(target=_version_status_bar_loop, name="version-status-bar", daemon=True)
    th.start()


@app.get("/api/admin/version-status")
def admin_version_status(request: Request) -> dict[str, Any]:
    """返回当前版本与已缓存的 GitHub 最新版本（仅本机；快照由后台线程定期刷新）。"""
    require_localhost(request)
    with _version_status_lock:
        snap = dict(_version_status_snapshot)
    return snap


def main() -> None:
    import uvicorn

    _prevent_system_sleep_install()
    _start_version_status_bar_thread()

    port = _server_port()
    host = os.environ.get("HOST", "0.0.0.0")

    if _use_webview_shell():
        if _run_with_webview():
            return
        print("已自动回退：仅控制台服务模式（无 WebView 依赖）。", flush=True)
        _spawn_windows_fallback_console_hint(port)
        _open_admin_in_browser_when_ready(port)

    _print_startup_info(port)
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="warning",
        access_log=False,
    )


if __name__ == "__main__":
    main()
