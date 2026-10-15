#!/usr/bin/env bash
# 红探 Agent launcher（macOS/Linux）
# 有 Node >= 22 → runtime-launch.mjs（先试受管运行时，否则回退本机 Node 跑同一份源码）
# 无 Node     → bootstrap-runtime.sh（按 runtime.manifest.json 下载 + SHA-256 校验后执行）

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

node_major() {
    "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null
}

# PATH 上可能有多个 node：只探第一个，会在「首个 < 22 但后方还有 ≥22」时误走免 Node 路径。
# type -ap 按查找顺序列出全部候选，取首个主版本 ≥ 22 的。
while IFS= read -r candidate; do
    [ -n "$candidate" ] || continue
    NODE_MAJOR="$(node_major "$candidate")" || continue
    [ -n "$NODE_MAJOR" ] || continue
    if [ "$NODE_MAJOR" -ge 22 ] 2>/dev/null; then
        exec "$candidate" "$SCRIPT_DIR/runtime-launch.mjs" "$@"
    fi
done < <(type -ap node)

exec bash "$SCRIPT_DIR/bootstrap-runtime.sh" "$@"
