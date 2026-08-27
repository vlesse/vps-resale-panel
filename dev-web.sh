#!/usr/bin/env bash
# 前端开发服务器。
#
# 两个坑写在这里免得再踩：
#  1. 旧进程不杀干净会 EADDRINUSE，而端口上那个旧版本还在响应，
#     很容易误以为新代码生效了。
#  2. 千万不要在 dev 跑着的时候执行 next build —— 生产构建会覆盖 .next/，
#     把开发用的 chunk 全删掉，浏览器加载 /_next/static/chunks/*.js 全部 404，
#     页面只剩服务端渲染的 HTML，所有交互和 useEffect 都不执行。
#     症状极具迷惑性：页面看着正常，但所有数据都是空的。
set -e
PORT="${PORT:-3011}"
cd "$(dirname "$0")/apps/web"

PID=$(netstat -ano 2>/dev/null | grep -E ":${PORT}\s+.*LISTENING" | awk '{print $NF}' | head -1)
if [ -n "$PID" ]; then
  echo "结束占用 ${PORT} 的旧进程 PID=$PID"
  powershell.exe -NoProfile -Command "Stop-Process -Id $PID -Force" 2>/dev/null || true
  sleep 3
fi

node ../../node_modules/next/dist/bin/next dev -p "$PORT" > /tmp/web.log 2>&1 &
for i in $(seq 1 40); do
  if curl -s -m 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    echo "前端已启动 http://127.0.0.1:${PORT}"
    exit 0
  fi
  sleep 2
done
echo "启动失败，日志末尾："; tail -20 /tmp/web.log
exit 1
