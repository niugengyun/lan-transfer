param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ArgsFromCli
)

$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
  # ignore
}

function Get-PythonCmd {
  $py = Get-Command py -ErrorAction SilentlyContinue
  if ($py) { return @("py", "-3") }
  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python) { return @("python") }
  throw "未找到 Python。请先安装 Python 3.9+，并确保 PATH 中可用 python 或 py。"
}

function Invoke-CmdChecked {
  param(
    [Parameter(Mandatory = $true)][string[]]$Command
  )
  if ($Command.Length -le 1) {
    & $Command[0]
  } else {
    & $Command[0] @($Command[1..($Command.Length - 1)])
  }
  if ($LASTEXITCODE -ne 0) {
    throw "命令执行失败: $($Command -join ' ')"
  }
}

if (-not (Test-Path -LiteralPath ".venv\Scripts\python.exe")) {
  Write-Host "正在创建虚拟环境 .venv ..."
  $pyCmd = Get-PythonCmd
  Invoke-CmdChecked -Command ($pyCmd + @("-m", "venv", ".venv"))
}

$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $venvPython)) {
  throw "未找到 .venv\Scripts\python.exe，虚拟环境创建失败。"
}

$env:PIP_INDEX_URL = "https://pypi.tuna.tsinghua.edu.cn/simple"
Write-Host "正在安装 Python 依赖 (requirements.txt, pip: $($env:PIP_INDEX_URL)) ..."
Invoke-CmdChecked -Command @($venvPython, "-m", "pip", "install", "-r", "requirements.txt", "-q")

if (Test-Path -LiteralPath "create_icon.py") {
  Write-Host "正在生成图标 (icons/app_icon.*) ..."
  Invoke-CmdChecked -Command @($venvPython, "create_icon.py")
}

if (Test-Path -LiteralPath "frontend\package.json") {
  if (-not (Test-Path -LiteralPath "frontend\.npmrc")) {
    "registry=https://registry.npmmirror.com" | Out-File -FilePath "frontend\.npmrc" -Encoding ascii
    Write-Host "已创建 frontend\.npmrc (npmmirror)."
  }
  Write-Host "正在安装前端依赖 (frontend/) ..."
  Push-Location "frontend"
  try {
    Invoke-CmdChecked -Command @("npm", "install")
  } finally {
    Pop-Location
  }
} else {
  Write-Host "未找到 frontend\package.json, 跳过 npm 安装."
}

Write-Host "正在启动服务 ..."
& $venvPython "server.py" @ArgsFromCli
exit $LASTEXITCODE
