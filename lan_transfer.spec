# -*- mode: python ; coding: utf-8 -*-
# 先执行: cd frontend && npm ci && npm run build
# 再执行: pip install -r requirements.txt -r requirements-build.txt && python create_icon.py && pyinstaller lan_transfer.spec --clean

import sys
from pathlib import Path

try:
    _ROOT = Path(SPECPATH)
except NameError:
    _ROOT = Path(SPEC).resolve().parent

_spa = _ROOT / "static" / "spa"
if not _spa.is_dir():
    raise RuntimeError(f"缺少前端构建目录 {_spa}，请先执行 frontend 下 npm run build")

_datas = [(str(_spa), "static/spa")]
_icon_png = _ROOT / "static" / "icon.png"
if _icon_png.is_file():
    _datas.append((str(_icon_png), "static"))

_icons_dir = _ROOT / "icons"
if _icons_dir.is_dir():
    _datas.append((str(_icons_dir), "icons"))

try:
    from PyInstaller.utils.hooks import collect_data_files

    _datas += collect_data_files("webview")
except Exception:
    pass

block_cipher = None

a = Analysis(
    ["server.py"],
    pathex=[str(_ROOT)],
    binaries=[],
    datas=_datas,
    hiddenimports=[
        "anyio",
        "anyio._backends",
        "anyio._backends._asyncio",
        "multipart",
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "websockets",
        "websockets.legacy",
        "websockets.legacy.server",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    name="lan_transfer",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(_ROOT / "icons" / "app_icon.ico"),
)

if sys.platform == "darwin":
    app = BUNDLE(
        exe,
        name="lan_transfer.app",
        icon=str(_ROOT / "icons" / "app_icon.icns"),
        bundle_identifier="com.niugengyun.lantransfer",
    )
