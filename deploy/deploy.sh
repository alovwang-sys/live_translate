#!/usr/bin/env bash
# 本机一键部署：构建 → 打包上传到服务器 /opt/live_translate → 安装依赖 → 重启服务。
# 首次部署前先按 AGENTS.md「部署」一节在服务器上建 .env、systemd 服务和 nginx 配置。
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${DEPLOY_HOST:-aliyun-server-2}"
DIR=/opt/live_translate

npm run typecheck
npm run build

echo "→ 上传到 $HOST:$DIR"
COPYFILE_DISABLE=1 tar --no-xattrs -czf - dist package.json package-lock.json deploy | ssh "$HOST" "
  set -e
  mkdir -p $DIR
  cd $DIR
  rm -rf dist
  tar xzf -
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
  chown -R live_translate:live_translate $DIR
  chmod 600 $DIR/.env 2>/dev/null || true
  systemctl restart live_translate
  sleep 2
  systemctl is-active live_translate
  curl -fsS http://127.0.0.1:8787/healthz && echo
"
echo "✓ 已部署：https://magictoolse.com/live/"
