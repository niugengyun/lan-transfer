#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
按 LAN Transfer 品牌样式（2×2 四色宫格 + 白十字缝）绘制 512×512 图，
生成 icons/app_icon.ico；在 macOS 上生成 app_icon.icns。
不读取本地 PNG 源文件。
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT_DIR = Path(__file__).resolve().parent
ICONS_DIR = ROOT_DIR / "icons"
OUTPUT_ICO = ICONS_DIR / "app_icon.ico"
OUTPUT_ICNS = ICONS_DIR / "app_icon.icns"

# 与用户提供的参考图一致（左上蓝、右上绿、左下琥珀、右下蓝）
_COLOR_TL = (30, 136, 229, 255)  # #1E88E5
_COLOR_TR = (124, 179, 66, 255)  # #7CB342
_COLOR_BL = (255, 179, 0, 255)  # #FFB300
_COLOR_BR = (30, 136, 229, 255)  # #1E88E5
_GUTTER_BG = (255, 255, 255, 255)


def build_brand_icon_rgba(size: int = 512) -> Image.Image:
    """绘制正方形品牌图标（PIL 矩形为 [x0,y0,x1,y1]，右下为开区间外沿）。"""
    s = max(32, int(size))
    img = Image.new("RGBA", (s, s), _GUTTER_BG)
    draw = ImageDraw.Draw(img)
    gap = max(2, round(s * 0.035))
    cell = (s - gap) // 2
    if cell < 1:
        cell = s // 2
        gap = s - 2 * cell
    x_mid = cell + gap
    y_mid = cell + gap
    # 左上 | 右上
    # -----+-----
    # 左下 | 右下
    draw.rectangle((0, 0, cell, cell), fill=_COLOR_TL)
    draw.rectangle((x_mid, 0, s, cell), fill=_COLOR_TR)
    draw.rectangle((0, y_mid, cell, s), fill=_COLOR_BL)
    draw.rectangle((x_mid, y_mid, s, s), fill=_COLOR_BR)
    return img


def build_ico(rgba: Image.Image) -> None:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    rgba.save(OUTPUT_ICO, format="ICO", sizes=sizes)
    print(f"[icon] 已生成 {OUTPUT_ICO}")


def build_icns(rgba: Image.Image) -> None:
    iconutil = shutil.which("iconutil")
    if not iconutil:
        print("[icon] 未找到 iconutil，跳过 icns 生成")
        return

    mapping = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }

    with tempfile.TemporaryDirectory() as tmpdir:
        iconset_dir = Path(tmpdir) / "app_icon.iconset"
        iconset_dir.mkdir(parents=True, exist_ok=True)
        for filename, sz in mapping.items():
            out_file = iconset_dir / filename
            rgba.resize((sz, sz), Image.Resampling.LANCZOS).save(out_file, format="PNG")

        cmd = [iconutil, "-c", "icns", str(iconset_dir), "-o", str(OUTPUT_ICNS)]
        subprocess.run(cmd, check=True)

    print(f"[icon] 已生成 {OUTPUT_ICNS}")


def main() -> None:
    rgba = build_brand_icon_rgba(512)
    build_ico(rgba)
    build_icns(rgba)


if __name__ == "__main__":
    main()
