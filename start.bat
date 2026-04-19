@echo off
setlocal EnableExtensions
REM 一键：创建/使用 .venv、安装 pip 依赖、配置 npm 镜像并安装 frontend 依赖，最后启动 server.py（与 start.sh 对齐）
cd /d "%~dp0"

REM 控制台 UTF-8，减少中文提示乱码
chcp 65001 >nul 2>&1

if not exist ".venv\Scripts\python.exe" (
  echo 正在创建虚拟环境 .venv ...
  python -m venv .venv 2>nul
  if errorlevel 1 (
    py -3 -m venv .venv 2>nul
    if errorlevel 1 (
      echo 错误：无法创建虚拟环境。请安装 Python 3.9+ 并确保 PATH 中有 python 或 py 启动器。
      exit /b 1
    )
  )
)

call ".venv\Scripts\activate.bat"
if errorlevel 1 (
  echo 错误：无法激活 .venv\Scripts\activate.bat
  exit /b 1
)

set "PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple"
echo 正在安装 Python 依赖 (requirements.txt, pip: %PIP_INDEX_URL%) ...
python -m pip install -r requirements.txt -q
if errorlevel 1 (
  echo 错误：pip install 失败。
  exit /b 1
)

if exist "create_icon.py" (
  echo 正在生成图标 (icons/app_icon.ico 等) ...
  python create_icon.py
)

if exist "frontend\package.json" (
  if not exist "frontend\.npmrc" (
    (echo registry=https://registry.npmmirror.com) > "frontend\.npmrc"
    echo 已创建 frontend\.npmrc (npmmirror).
  )
  echo 正在安装前端依赖 (frontend\) ...
  pushd frontend
  call npm install
  if errorlevel 1 (
    echo 错误：npm install 失败。
    popd
    exit /b 1
  )
  popd
) else (
  echo 未找到 frontend\package.json, 跳过 npm 安装.
)

echo 正在启动服务 ...
python server.py %*

endlocal
