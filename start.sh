#!/bin/bash
cd "$(dirname "$0")"
if [ -f .env.local ]; then
  set -a
  . ./.env.local
  set +a
fi
echo "🏹 启动金币猎人..."
node server.js &
SERVER_PID=$!
sleep 1
open http://localhost:3737
echo "已在浏览器打开 http://localhost:3737"
echo "按 Ctrl+C 停止服务"
wait $SERVER_PID
