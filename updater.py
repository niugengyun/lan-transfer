"""
检查 GitHub 最新 Release（与 veo3free-main/updater.py 逻辑对齐，无 loguru 依赖）。
"""

from __future__ import annotations

import json
import logging
import platform
import urllib.error
import urllib.request
import webbrowser
from dataclasses import dataclass
from typing import Any, Callable, Optional

from version import GITHUB_REPO, UPDATE_USER_AGENT, compare_versions, get_version

logger = logging.getLogger("lan_transfer.updater")


def _pick_download_url(assets: list[dict[str, Any]], system: str) -> str:
    """
    按平台选择 Release 资源（与多产物发版对齐）：
    macOS 优先 *macos*.dmg、再 *macos*.zip；Windows 优先 *windows*.zip、再 *.exe；
    否则回退到含 lan-transfer 的 .zip（源码包等）。
    """
    rows: list[tuple[str, str]] = []
    for a in assets:
        name = (a.get("name") or "").strip()
        url = (a.get("browser_download_url") or "").strip()
        if not name or not url:
            continue
        rows.append((name.lower(), url))

    def first(pred: Callable[[str], bool]) -> str:
        for ln, url in rows:
            if pred(ln):
                return url
        return ""

    s = (system or "").lower()
    if s == "darwin":
        u = first(lambda n: "macos" in n and n.endswith(".dmg"))
        if u:
            return u
        u = first(lambda n: "macos" in n and n.endswith(".zip"))
        if u:
            return u
        u = first(lambda n: n.endswith(".dmg"))
        if u:
            return u
    elif s in ("win32", "windows") or s.startswith("win"):
        u = first(lambda n: "windows" in n and n.endswith(".zip"))
        if u:
            return u
        u = first(lambda n: n.endswith(".exe"))
        if u:
            return u

    u = first(lambda n: ("lan-transfer" in n or "transfer" in n) and n.endswith(".zip"))
    if u:
        return u
    return first(lambda n: n.endswith(".zip"))


@dataclass
class UpdateInfo:
    has_update: bool
    current_version: str
    latest_version: str
    release_notes: str
    download_url: str
    release_url: str


def check_for_updates() -> Optional[UpdateInfo]:
    """查询 GitHub releases/latest；失败返回 None。"""
    current = get_version()
    if os_env_dev():
        logger.debug("LAN_TRANSFER_DEV=1，跳过更新检查")
        return None
    if (current or "").lower() in ("dev", "0.0.0-dev"):
        return None

    try:
        api_url = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
        request = urllib.request.Request(
            api_url,
            headers={
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": UPDATE_USER_AGENT,
            },
        )
        with urllib.request.urlopen(request, timeout=12) as response:
            data = json.loads(response.read().decode("utf-8"))

        latest_version = (data.get("tag_name") or "").lstrip("v")
        release_notes = data.get("body") or ""
        release_url = data.get("html_url") or ""

        system = platform.system().lower()
        download_url = _pick_download_url(data.get("assets") or [], system)

        if not download_url:
            download_url = release_url

        has_update = compare_versions(current, latest_version) < 0
        return UpdateInfo(
            has_update=has_update,
            current_version=current,
            latest_version=latest_version,
            release_notes=release_notes,
            download_url=download_url,
            release_url=release_url,
        )
    except urllib.error.URLError as e:
        logger.warning("检查更新网络错误: %s", e)
        return None
    except (json.JSONDecodeError, OSError, ValueError) as e:
        logger.warning("检查更新解析错误: %s", e)
        return None
    except Exception as e:
        logger.warning("检查更新异常: %s", e)
        return None


def os_env_dev() -> bool:
    import os

    return os.environ.get("LAN_TRANSFER_DEV", "").strip() in ("1", "true", "yes")


def open_download_page(url: str) -> bool:
    try:
        webbrowser.open(url)
        return True
    except Exception as e:
        logger.warning("打开浏览器失败: %s", e)
        return False
