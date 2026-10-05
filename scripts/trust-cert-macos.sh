#!/usr/bin/env bash
# macOS：将服务端自签名证书加入钥匙串信任（消除浏览器证书警告）
# 流程：执行后会弹出「钥匙串访问」授权框 → 输入开机密码 → 点「始终允许」→ 本脚本自动验证
# 用法：./scripts/trust-cert-macos.sh [端口，默认 9111]
set -euo pipefail
PORT="${1:-9111}"
CERT="$(cd "$(dirname "$0")/.." && pwd)/data/tls/cert.pem"

[ -f "$CERT" ] || { echo "错误: 未找到证书 ${CERT}（先启动一次服务自动生成）"; exit 1; }

echo "── 即将弹出系统授权框 ──────────────────"
echo "  请输入开机密码并点「始终允许」（约 30 秒内完成，脚本会自动验证）"
echo ""

security add-trusted-cert -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$CERT" &
SEC_PID=$!

# 轮询验证：无 -k 的 curl 成功 = 系统信任生效（对 Safari/Keychain 系浏览器生效；
# Chrome/Chromium 使用自有根存储，仍需在其警告页点一次「继续前往」）
OK=""
for _ in $(seq 1 30); do
  if ! kill -0 "$SEC_PID" 2>/dev/null; then
    break # 授权框被关闭/取消
  fi
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "https://localhost:$PORT/api/health" 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then OK="yes"; break; fi
  sleep 2
done

if ! kill -0 "$SEC_PID" 2>/dev/null && [ -z "$OK" ]; then
  wait "$SEC_PID" 2>/dev/null || true
fi

if [ "$OK" = "yes" ]; then
  echo "系统信任已生效（curl 无需 -k 即可访问）——Safari/Keychain 系浏览器不再警告"
else
  echo "! 自动验证未通过。两种可能："
  echo "   1) 授权框被取消/超时 —— 重新运行本脚本再试"
  echo "   2) Chrome/Chromium 使用自有根证书库，不读钥匙串信任 ——"
  echo "      在其证书警告页点「高级 → 继续前往 localhost」即可（一次性，会话内有效）"
  exit 1
fi
