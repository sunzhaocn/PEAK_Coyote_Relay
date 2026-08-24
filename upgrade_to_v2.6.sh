#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
[ -f .coyote-deploy.env ] || { echo "未找到现有部署状态 .coyote-deploy.env；首次部署请执行 ./deploy.sh"; exit 1; }
chmod +x manage.sh deploy.sh 2>/dev/null || true
echo "[1/3] 备份现有配置 / 证书 / 安全数据"
./manage.sh backup
echo "[2/3] 重建镜像并强制刷新容器"
./manage.sh reload
echo "[3/3] 状态检查"
./manage.sh status
echo
echo "V2.6 升级完成。运行 ./manage.sh doctor 可做完整诊断。"
