#!/usr/bin/env bash
# 停止编排服务：自动识别运行方式（launchd / systemd / 手动进程）并优雅停止
# 用法：./scripts/stop.sh
#   重新启动：./scripts/start.sh（系统服务会重新 load/start；手动模式走前台运行）
set -euo pipefail
OS="$(uname -s)"
LABEL="com.unity-test-platform.orchestrator"
SERVICE_NAME="unity-orchestrator"
PROC_PATTERN="gameqa.js serve"

stopped=""

case "$OS" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    LAUNCHED="$(launchctl list 2>/dev/null || true)"
    if [ -f "$PLIST" ] && printf "%s" "$LAUNCHED" | grep -q "$LABEL"; then
      # KeepAlive 会拉起，必须 unload 才是真正的"停止"
      launchctl unload "$PLIST"
      stopped="launchd 服务（已卸载，下次开机仍会自启；永久卸载用 scripts/uninstall-service.sh）"
    fi
    ;;
  Linux)
    if command -v systemctl >/dev/null && systemctl list-unit-files | grep -q "$SERVICE_NAME"; then
      sudo systemctl stop "$SERVICE_NAME"
      stopped="systemd 服务（已停止；开机自启配置保留，重新启动用 systemctl start 或 scripts/start.sh）"
    fi
    ;;
esac

# 手动进程（前台/后台启动的）兜底清理
if pgrep -f "$PROC_PATTERN" >/dev/null 2>&1; then
  pkill -TERM -f "$PROC_PATTERN" 2>/dev/null || true
  sleep 1
  pgrep -f "$PROC_PATTERN" >/dev/null 2>&1 && pkill -KILL -f "$PROC_PATTERN" 2>/dev/null || true
  stopped="${stopped:+$stopped + }手动进程（SIGTERM 优雅停机）"
fi

if [ -n "$stopped" ]; then
  echo "已停止: $stopped"
else
  echo "没有正在运行的编排服务。"
fi
