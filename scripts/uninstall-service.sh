#!/usr/bin/env bash
# 卸载系统服务（与 install-service.sh 配对）
set -euo pipefail
OS="$(uname -s)"
SERVICE_LABEL="com.unity-test-platform.orchestrator"

case "$OS" in
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
    if [ -f "$PLIST" ]; then
      launchctl unload "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
      echo "macOS 服务已卸载"
    else
      echo "未找到 $PLIST"
    fi
    ;;
  Linux)
    if [ -f /etc/systemd/system/unity-orchestrator.service ]; then
      sudo systemctl disable --now unity-orchestrator 2>/dev/null || true
      sudo rm -f /etc/systemd/system/unity-orchestrator.service
      sudo systemctl daemon-reload
      echo "systemd 服务已卸载"
    else
      echo "未找到 unity-orchestrator.service"
    fi
    ;;
  *)
    echo "不支持的平台: $OS"; exit 1;;
esac
