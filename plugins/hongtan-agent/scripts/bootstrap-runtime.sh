#!/usr/bin/env bash
# 红探 Agent 免 Node 引导（macOS/Linux）——设计文档 §13「launcher」行 / 执行计划 S13。
#
# 职责：当本机没有可用 Node（< 22）时，按 runtime.manifest.json 下载 standalone 运行时、
# 校验 SHA-256 后才落地并执行；校验不通过一律拒绝（绝不执行未校验字节）。
# 状态目录无清单时，先按接入包版本从发布地址自动获取清单（失败不阻断）。
#
# 与 runtime-launch.mjs 的关系：有 Node 走 runtime-launch.mjs（同一份清单、同一套校验语义）；
# 本脚本是「无 Node」路径。
#
# 用法：
#   bash bootstrap-runtime.sh [--install-only] [--state-dir DIR] [子进程参数…]
# 退出码：0 成功；1 无清单/清单无当前平台条目；2 下载或校验失败；其它为子进程退出码。
set -euo pipefail

STATE_DIR=""
INSTALL_ONLY=0
CHILD_ARGS=()

while [ $# -gt 0 ]; do
    case "$1" in
        --install-only) INSTALL_ONLY=1; shift ;;
        --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
        *) CHILD_ARGS+=("$1"); shift ;;
    esac
done

fail() {
    echo "[hongtan-agent] $1" >&2
    exit "${2:-1}"
}

platform_key() {
    local os arch
    case "$(uname -s)" in
        Linux) os="linux" ;;
        Darwin) os="darwin" ;;
        *) os="linux" ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64) arch="x64" ;;
        arm64|aarch64) arch="arm64" ;;
        *) arch="x64" ;;
    esac
    echo "${os}-${arch}"
}

sha256_of() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    elif command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        fail "缺少 SHA-256 工具（shasum 或 sha256sum）" 2
    fi
}

# 读清单字段；优先 jq，其次 python3/python（免 Node 是这个脚本存在的理由）
json_field() {
    local field="$1" py=""
    if command -v jq >/dev/null 2>&1; then
        jq -r --arg k "$KEY" --arg f "$field" '(.platforms[$k] // {})[$f] // ""' "$MANIFEST"
        return 0
    fi
    if command -v python3 >/dev/null 2>&1; then py=python3
    elif command -v python >/dev/null 2>&1; then py=python
    else fail "缺少 JSON 解析工具（jq 或 python3），无法读取运行时清单" 2
    fi
    "$py" - "$MANIFEST" "$KEY" "$field" <<'PY'
import json, sys
manifest, key, field = sys.argv[1], sys.argv[2], sys.argv[3]
with open(manifest, encoding="utf-8") as handle:
    data = json.load(handle)
value = ((data.get("platforms") or {}).get(key) or {}).get(field)
print(value if isinstance(value, str) else "")
PY
}

# 读接入包 plugin.json 字段（本脚本在 plugins/hongtan-agent/scripts/ 下，包根是其父目录）。
# 与 json_field 同样优先 jq；两者都没有时返回空（seeding 尽力而为，不因缺工具改变退出码语义）
plugin_json_field() {
    local field="$1" py="" plugin_json
    plugin_json="$(cd "$(dirname "$0")" && pwd)/../.codebuddy-plugin/plugin.json"
    if [ ! -f "$plugin_json" ]; then
        echo ""
        return 0
    fi
    if command -v jq >/dev/null 2>&1; then
        jq -r --arg f "$field" '.[$f] // ""' "$plugin_json"
        return 0
    fi
    if command -v python3 >/dev/null 2>&1; then py=python3
    elif command -v python >/dev/null 2>&1; then py=python
    else
        echo ""
        return 0
    fi
    "$py" - "$plugin_json" "$field" <<'PY'
import json, sys
path, field = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)
value = data.get(field)
print(value if isinstance(value, str) else "")
PY
}

# 清单 seeding：状态目录无清单时按接入包版本从发布地址拉取（版本钉死防漂移）。
# 失败静默——由无清单报错兜底，与「无清单回退系统 Node」同语义
seed_manifest() {
    local seed_url version
    seed_url="${HONGTAN_AGENT_MANIFEST_SEED_URL:-}"
    if [ -z "$seed_url" ]; then
        version="$(plugin_json_field version)"
        [ -n "$version" ] || return 1
        seed_url="https://github.com/wsepr/hongtan-agent/releases/download/v${version}/runtime.manifest.json"
    fi
    mkdir -p "$STATE_DIR"
    curl -fsSL "$seed_url" -o "$MANIFEST.part" || { rm -f "$MANIFEST.part"; return 1; }
    mv -f "$MANIFEST.part" "$MANIFEST"
    echo "[hongtan-agent] 已从发布地址获取运行时清单" >&2
}

if [ -n "${HONGTAN_AGENT_RUNTIME:-}" ]; then
    [ "$INSTALL_ONLY" = "1" ] && exit 0
    exec "$HONGTAN_AGENT_RUNTIME" ${CHILD_ARGS[@]+"${CHILD_ARGS[@]}"}
fi

if [ -z "$STATE_DIR" ]; then
    STATE_DIR="${HONGTAN_AGENT_STATE_DIR:-$HOME/.config/hongtan-agent}"
fi

MANIFEST="$STATE_DIR/runtime.manifest.json"
[ -f "$MANIFEST" ] || seed_manifest || true
[ -f "$MANIFEST" ] || fail "未找到运行时清单 $MANIFEST，且从发布地址自动获取失败（请安装 Node 22+ 走系统 Node 路径，或检查网络与发布产物是否就绪）" 1

KEY="$(platform_key)"
URL="$(json_field url)"
EXECUTABLE="$(json_field executable)"
EXPECTED="$(json_field sha256 | tr 'A-Z' 'a-z')"

[ -n "$URL" ] && [ -n "$EXECUTABLE" ] || fail "运行时清单缺少当前平台条目（$KEY）" 1
[ -n "$EXPECTED" ] || fail "运行时清单缺少 sha256，拒绝安装未校验的二进制" 2

RUNTIME_DIR="$STATE_DIR/runtime"
mkdir -p "$RUNTIME_DIR"
TARGET="$RUNTIME_DIR/$(basename "$EXECUTABLE")"

if [ ! -f "$TARGET" ] || [ "$(sha256_of "$TARGET")" != "$EXPECTED" ]; then
    if [ -f "$TARGET" ]; then
        echo "[hongtan-agent] 受管运行时校验不通过，重新下载" >&2
        rm -f "$TARGET"
    fi
    PART="$TARGET.part"
    curl -fsSL "$URL" -o "$PART" || { rm -f "$PART"; fail "下载运行时失败（$URL）" 2; }
    ACTUAL="$(sha256_of "$PART")"
    if [ "$ACTUAL" != "$EXPECTED" ]; then
        rm -f "$PART"
        fail "运行时 SHA-256 校验失败（期望 $EXPECTED，实际 $ACTUAL），已拒绝安装" 2
    fi
    mv -f "$PART" "$TARGET"
    chmod 755 "$TARGET" 2>/dev/null || true
    echo "[hongtan-agent] 已安装运行时（SHA-256 校验通过）" >&2
fi

[ "$INSTALL_ONLY" = "1" ] && exit 0
exec "$TARGET" ${CHILD_ARGS[@]+"${CHILD_ARGS[@]}"}
