"""版本号与 GitHub 仓库（与 veo3free 的 version.py 结构对齐，供在线升级使用）。"""

APP_NAME = "lan-transfer"
GITHUB_REPO = "niugengyun/lan-transfer"
UPDATE_USER_AGENT = f"{APP_NAME}-updater"
__version__ = "0.1.0"


def get_version() -> str:
    """当前应用版本号（与 GitHub Release tag 对应，可带或不带 v 前缀比较）。"""
    return __version__


def compare_versions(current: str, latest: str) -> int:
    """
    比较两个版本号。
    返回: -1 当前较旧, 0 相同, 1 当前较新。
    """
    def parse_version(v: str) -> tuple:
        v = (v or "").lstrip("v").strip()
        parts = v.split(".")
        while len(parts) < 3:
            parts.append("0")
        out: list[int] = []
        for p in parts[:3]:
            try:
                out.append(int(p))
            except ValueError:
                out.append(0)
        return tuple(out)

    try:
        ct = parse_version(current)
        lt = parse_version(latest)
        if ct < lt:
            return -1
        if ct > lt:
            return 1
        return 0
    except (ValueError, IndexError):
        return 0
