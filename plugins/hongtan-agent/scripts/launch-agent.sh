#!/usr/bin/env bash
# 红探 Agent launcher（macOS/Linux）
# 有 Node >= 22 → runtime-launch.mjs（先试受管运行时，否则回退本机 Node 跑同一份源码）
# 无 Node     → bootstrap-runtime.sh（按 runtime.manifest.json 下载 + SHA-256 校验后执行）

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    if [ "$NODE_MAJOR" -ge 22 ]; then
        exec node "$SCRIPT_DIR/runtime-launch.mjs" "$@"
    fi
fi

exec bash "$SCRIPT_DIR/bootstrap-runtime.sh" "$@"
