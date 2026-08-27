#!/usr/bin/env bash
# 本地开发用：先杀掉占着端口的旧进程，再重新构建启动。
# 直接 node dist/main.js 的话，旧进程还在就会 EADDRINUSE 起不来，
# 而端口上还有个旧版本在响应，很容易误以为新代码生效了。
set -e
PORT="${PORT:-3010}"
cd "$(dirname "$0")/apps/api"

PID=$(netstat -ano 2>/dev/null | grep -E ":${PORT}\s+.*LISTENING" | awk '{print $NF}' | head -1)
if [ -n "$PID" ]; then
  echo "结束占用 ${PORT} 端口的旧进程 PID=$PID"
  powershell.exe -NoProfile -Command "Stop-Process -Id $PID -Force" 2>/dev/null || kill -9 "$PID" 2>/dev/null || true
  sleep 2
fi

echo "构建中..."
npx nest build
echo "启动中..."
node dist/main.js > /tmp/api.log 2>&1 &
for i in $(seq 1 30); do
  if curl -s -m 2 "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "已启动，路由数：$(grep -c 'Mapped' /tmp/api.log)"
    curl -s "http://127.0.0.1:${PORT}/api/health"; echo
    exit 0
  fi
  sleep 2
done
echo "启动失败，日志末尾："
tail -20 /tmp/api.log
exit 1
