#!/usr/bin/env sh
set -eu

case "$0" in
    */*) script_dir=${0%/*} ;;
    *\\*) script_dir=${0%\\*} ;;
    *) script_dir=. ;;
esac
SCRIPT_DIR=$(CDPATH= cd -- "$script_dir" && pwd)

# 与 launch-agent.cmd 同源：override -> PATH 里的 node -> WorkBuddy 自带 Node，
# 每一项都实际执行一次并校验 major >= 22（不能只看第一个候选）。
probe_node() {
    [ -n "$1" ] || return 1
    if ! command -v "$1" >/dev/null 2>&1 && [ ! -x "$1" ]; then
        return 1
    fi
    major=$("$1" -p "process.versions.node.split('.')[0]" 2>/dev/null || true)
    case "$major" in
        ''|*[!0-9]*) return 1 ;;
    esac
    [ "$major" -ge 22 ]
}

NODE_BIN=""
if [ -n "${HONGTAN_AGENT_NODE:-}" ] && probe_node "$HONGTAN_AGENT_NODE"; then
    NODE_BIN="$HONGTAN_AGENT_NODE"
fi
if [ -z "$NODE_BIN" ] && [ -n "${PATH:-}" ]; then
    old_ifs=$IFS
    IFS=:
    for dir in $PATH; do
        [ -n "$dir" ] || dir=.
        candidate="$dir/node"
        if [ -x "$candidate" ] && probe_node "$candidate"; then
            NODE_BIN="$candidate"
            break
        fi
    done
    IFS=$old_ifs
fi
if [ -z "$NODE_BIN" ] && [ -n "${HOME:-}" ]; then
    for candidate in "$HOME"/.workbuddy/binaries/node/versions/*/node; do
        if [ -x "$candidate" ] && probe_node "$candidate"; then
            NODE_BIN="$candidate"
            break
        fi
    done
fi

if [ -z "$NODE_BIN" ]; then
    echo "[hongtan] Node.js 22 or newer is required. Install Node.js or set HONGTAN_AGENT_NODE." >&2
    exit 1
fi

exec "$NODE_BIN" "$SCRIPT_DIR/../runtime/hongtan-agent.mjs" "$@"
