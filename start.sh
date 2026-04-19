#!/usr/bin/env bash
# 一键：创建/使用 .venv、安装 pip 依赖、配置 npm 镜像并安装 frontend 依赖，最后启动服务
set -e
cd "$(dirname "$0")"

# 终端非 UTF-8 时中文易乱码；优先 UTF-8（不覆盖用户已显式设置的有效 LANG）
if [[ -z "${LANG:-}" || "${LANG}" == C || "${LANG}" == POSIX ]]; then
  export LANG="en_US.UTF-8"
fi

if [[ ! -d .venv ]]; then
  echo "正在创建虚拟环境 .venv ..."
  python3 -m venv .venv
fi
source .venv/bin/activate

PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"
export PIP_INDEX_URL
# 使用半角标点与 ASCII 省略号，避免 GBK 等编码下乱码
echo "正在安装 Python 依赖 (requirements.txt, pip: ${PIP_INDEX_URL}) ..."
pip install -r requirements.txt -q

if [[ -f create_icon.py ]]; then
  echo "正在生成 Dock / 打包用图标 (icons/app_icon.icns 等) ..."
  python create_icon.py
fi

if [[ -f frontend/package.json ]]; then
  if [[ ! -f frontend/.npmrc ]]; then
    echo "registry=https://registry.npmmirror.com" > frontend/.npmrc
    echo "已创建 frontend/.npmrc (npmmirror)."
  fi
  echo "正在安装前端依赖 (frontend/) ..."
  (cd frontend && npm install)
else
  echo "未找到 frontend/package.json, 跳过 npm 安装."
fi

echo "正在启动服务 ..."
exec python server.py "$@"
