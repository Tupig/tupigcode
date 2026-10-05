#!/usr/bin/env bash
# 注册编排服务为系统服务 + 开机自启
#   macOS  → launchd（~/Library/LaunchAgents）
#   Linux  → systemd（/etc/systemd/system）
# 前置：先运行 npm run build 产出 dist/cli/gameqa.js
# 卸载：scripts/uninstall-service.sh
set -euo pipefail
OS="$(uname -s)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$ROOT/dist/cli/gameqa.js"
NODE_BIN="$(command -v node || true)"
SERVICE_LABEL="com.unity-test-platform.orchestrator"
PORT="${PORT:-9111}"
PLATFORM_TOKEN="${PLATFORM_TOKEN:-}"

[ -n "$NODE_BIN" ] || { echo "错误: 未找到 node"; exit 1; }
[ -f "$ENTRY" ] || { echo "错误: 未找到 $ENTRY —— 先运行 npm run build"; exit 1; }

# PLATFORM_TOKEN（可选）：写入服务环境变量，启用 API 认证（公网部署强烈建议）
TOKEN_DICT_ENTRY=""
TOKEN_LINUX_LINE=""
if [ -n "$PLATFORM_TOKEN" ]; then
  TOKEN_DICT_ENTRY=$'\n    <key>PLATFORM_TOKEN</key><string>'"$PLATFORM_TOKEN"'</string>'
  TOKEN_LINUX_LINE="Environment=PLATFORM_TOKEN=$PLATFORM_TOKEN"
  echo "[提示] 已启用 PLATFORM_TOKEN（Agent 需设置同名变量访问 API）"
fi

case "$OS" in
  Darwin)
    PLIST_DIR="$HOME/Library/LaunchAgents"
    PLIST="$PLIST_DIR/$SERVICE_LABEL.plist"
    mkdir -p "$PLIST_DIR" "$ROOT/data"
    cat > "$PLIST" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVICE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ENTRY</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>DATA_DIR</key><string>$ROOT/data</string>$TOKEN_DICT_ENTRY
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ROOT/data/orchestrator.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/orchestrator.err.log</string>
</dict>
</plist>
XML
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    echo "macOS 服务已注册并启动（开机自启生效）"
    echo "   看板: https://localhost:$PORT （自签名证书，首次访问点「高级 → 继续前往」）"
    echo "   状态: launchctl list | grep unity-test-platform"
    echo "   卸载: scripts/uninstall-service.sh"
    ;;
  Linux)
    command -v systemctl >/dev/null || { echo "错误: 未检测到 systemd"; exit 1; }
    sudo tee /etc/systemd/system/unity-orchestrator.service >/dev/null <<UNIT
[Unit]
Description=Unity Test Platform Orchestrator (gameqa)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$NODE_BIN $ENTRY serve
WorkingDirectory=$ROOT
Environment=PORT=$PORT
Environment=DATA_DIR=$ROOT/data
$TOKEN_LINUX_LINE
Restart=always
RestartSec=3
User=$USER
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
    sudo systemctl daemon-reload
    sudo systemctl enable --now unity-orchestrator
    echo "systemd 服务已注册并启动（开机自启生效）"
    echo "   看板: https://localhost:$PORT （自签名证书，首次访问点「高级 → 继续前往」）"
    echo "   状态: systemctl status unity-orchestrator"
    echo "   日志: journalctl -u unity-orchestrator -f"
    echo "   卸载: scripts/uninstall-service.sh"
    ;;
  *)
    echo "不支持的平台: ${OS}（Windows 请用任务计划程序 schtasks /create /sc onstart，或 NSSM）"
    exit 1
    ;;
esac
