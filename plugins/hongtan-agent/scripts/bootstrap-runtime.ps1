<#
  红探 Agent 免 Node 引导（Windows）——设计文档 §13「launcher」行 / 执行计划 S13。

  职责：当本机没有可用 Node（< 22）时，按 `runtime.manifest.json` 下载 standalone 运行时、
  **校验 SHA-256 后才落地并执行**；校验不通过一律拒绝（绝不执行未校验字节）。
  状态目录无清单时，先按接入包版本从发布地址自动获取清单（失败不阻断）。

  与 `runtime-launch.mjs` 的关系：
  - 本脚本是「无 Node」路径（纯 PowerShell 5.1 可用，不依赖 pwsh 7）；
  - 有 Node 时走 `runtime-launch.mjs`（同一份清单与同一套校验语义）。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap-runtime.ps1 `
      -StateDir "%APPDATA%\红探 Agent" [-InstallOnly] [-ChildArgs "…"]

  退出码：0 成功；1 无清单/清单无当前平台条目；2 下载或校验失败；其它为子进程退出码。
#>
[CmdletBinding()]
param(
    [string]$StateDir = "",
    [string]$ChildArgs = "",
    [switch]$InstallOnly
)

$ErrorActionPreference = "Stop"

# 固定 UTF-8：本脚本的错误提示全部走 [Console]::Error.WriteLine，其字节编码跟随
# 所在控制台的代码页（中文 Windows 默认 936/GBK），而宿主（自动化测试 / 日志采集）
# 一律按 UTF-8 解码——不固定编码，中文提示就是乱码、测试无法断言。钉死为 UTF-8 后
# 行为与宿主环境无关。重定向/无控制台场景 setter 可能抛 IOException，失败则退回
# 系统默认（仅影响日志可读性，不影响退出码语义）。
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

# PS 5.1 在较老 Win10 构建上默认协议集不含 TLS 1.2，而 GitHub 发布地址强制 TLS 1.2+；
# 不钉死会把「协议协商失败」误判成「发布产物有问题」
try {
    [System.Net.ServicePointManager]::SecurityProtocol =
        [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
} catch { }

function Fail([string]$message, [int]$code) {
    # 不能用 Write-Error：$ErrorActionPreference = "Stop" 会让它以异常终止（退出码恒为 1），
    # 掩盖「下载失败=2 / 无清单=1」的区分。直接写 stderr 并显式 exit。
    [Console]::Error.WriteLine("[hongtan-agent] $message")
    exit $code
}

function Get-PlatformKey {
    switch ($env:PROCESSOR_ARCHITECTURE) {
        "AMD64" { return "win32-x64" }
        "ARM64" { return "win32-arm64" }
        "x86" { return "win32-ia32" }
        default { return "win32-x64" }
    }
}

function Get-ManifestSeedUrl {
    # 版本取自接入包 plugin.json（本脚本在 plugins/hongtan-agent/scripts/ 下，包根是其父目录）；
    # HONGTAN_AGENT_MANIFEST_SEED_URL 可显式覆盖（测试隔离 / 私有部署）。取不到版本则不做 seeding。
    if ($env:HONGTAN_AGENT_MANIFEST_SEED_URL) { return $env:HONGTAN_AGENT_MANIFEST_SEED_URL }
    try {
        $pluginJsonPath = Join-Path $PSScriptRoot "..\.codebuddy-plugin\plugin.json"
        $plugin = Get-Content -LiteralPath $pluginJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($plugin.version) {
            return "https://github.com/wsepr/hongtan-agent/releases/download/v$($plugin.version)/runtime.manifest.json"
        }
    } catch { }
    return ""
}

$runtimeOverride = $env:HONGTAN_AGENT_RUNTIME
if ($runtimeOverride) {
    if ($InstallOnly) { exit 0 }
    & $runtimeOverride @($ChildArgs -split '\s+' | Where-Object { $_ })
    exit $LASTEXITCODE
}

if (-not $StateDir) {
    if ($env:HONGTAN_AGENT_STATE_DIR) {
        $StateDir = $env:HONGTAN_AGENT_STATE_DIR
    } elseif ($env:APPDATA) {
        $StateDir = Join-Path $env:APPDATA "红探 Agent"
    } else {
        Fail "无法确定状态目录（未设置 HONGTAN_AGENT_STATE_DIR / APPDATA）" 1
    }
}

$manifestPath = Join-Path $StateDir "runtime.manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath)) {
    # 清单 seeding：状态目录无清单时按接入包版本从发布地址拉取（版本钉死防漂移）。
    # 失败不阻断——落入下方无清单报错，与「无清单回退系统 Node」同语义。
    $seedUrl = Get-ManifestSeedUrl
    if ($seedUrl) {
        try {
            New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
            $part = "$manifestPath.part"
            try {
                Invoke-WebRequest -Uri $seedUrl -OutFile $part -UseBasicParsing
                Move-Item -LiteralPath $part -Destination $manifestPath -Force
                Write-Host "[hongtan-agent] 已从发布地址获取运行时清单"
            } finally {
                # 半截清单不能留给下次被当成有效文件
                if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
            }
        } catch {
            Write-Warning "[hongtan-agent] 运行时清单自动获取失败：$($_.Exception.Message)"
        }
    }
}
if (-not (Test-Path -LiteralPath $manifestPath)) {
    Fail "未找到运行时清单 $manifestPath，且从发布地址自动获取失败（请安装 Node 22+ 走系统 Node 路径，或检查网络与发布产物是否就绪）" 1
}

try {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Fail "运行时清单无法解析：$($_.Exception.Message)" 1
}

$key = Get-PlatformKey
$entry = $null
if ($manifest.platforms) {
    $entry = $manifest.platforms.$key
}
if (-not $entry -or -not $entry.url -or -not $entry.executable) {
    Fail "运行时清单缺少当前平台条目（$key）" 1
}

$runtimeDir = Join-Path $StateDir "runtime"
if (-not (Test-Path -LiteralPath $runtimeDir)) {
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
}
$target = Join-Path $runtimeDir ([System.IO.Path]::GetFileName($entry.executable))
$expected = ""
if ($entry.sha256) { $expected = $entry.sha256.ToString().ToLowerInvariant() }

function Get-Sha256Hex([string]$path) {
    # 直接用 .NET 而非 Get-FileHash：不受 cmdlet 自动加载/语言模式影响（PS 5.1 与 7 均可）
    $stream = [System.IO.File]::OpenRead($path)
    try {
        $algorithm = [System.Security.Cryptography.SHA256]::Create()
        try {
            $bytes = $algorithm.ComputeHash($stream)
        } finally {
            $algorithm.Dispose()
        }
    } finally {
        $stream.Dispose()
    }
    return ([System.BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
}

function Test-Hash([string]$path, [string]$expectedHash) {
    if (-not $expectedHash) { return $false }
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    return (Get-Sha256Hex $path) -eq $expectedHash
}

if (-not (Test-Hash $target $expected)) {
    if (Test-Path -LiteralPath $target) {
        Write-Warning "[hongtan-agent] 受管运行时校验不通过，重新下载"
        Remove-Item -LiteralPath $target -Force
    }
    if (-not $expected) {
        Fail "运行时清单缺少 sha256，拒绝安装未校验的二进制" 2
    }
    $part = "$target.part"
    try {
        Invoke-WebRequest -Uri $entry.url -OutFile $part -UseBasicParsing
    } catch {
        if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
        Fail "下载运行时失败：$($_.Exception.Message)" 2
    }
    $actual = Get-Sha256Hex $part
    if ($actual -ne $expected) {
        Remove-Item -LiteralPath $part -Force
        Fail "运行时 SHA-256 校验失败（期望 $expected，实际 $actual），已拒绝安装" 2
    }
    Move-Item -LiteralPath $part -Destination $target -Force
    Write-Host "[hongtan-agent] 已安装运行时（SHA-256 校验通过）"
}

if ($InstallOnly) { exit 0 }

& $target @($ChildArgs -split '\s+' | Where-Object { $_ })
exit $LASTEXITCODE
