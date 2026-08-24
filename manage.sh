#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"

load_state(){
  [ -f .coyote-deploy.env ] || { echo "尚未部署；请先执行 ./deploy.sh"; exit 1; }
  set -a
  # shellcheck disable=SC1091
  source ./.coyote-deploy.env
  # shellcheck disable=SC1091
  [ -f .env ] && source ./.env
  set +a
  [ -n "${COMPOSE_FILE:-}" ] && [ -f "$COMPOSE_FILE" ] || { echo "部署状态中的 Compose 文件无效"; exit 1; }
}
backup_now(){
  local ts d; ts="$(date +%Y%m%d-%H%M%S)"; d="backups/manual-$ts"; mkdir -p "$d"
  cp -f .coyote-deploy.env Caddyfile.generated .env "$d/" 2>/dev/null || true
  [ -d sites ] && cp -a sites "$d/" || true
  if docker compose -f "$COMPOSE_FILE" ps --status running --services 2>/dev/null | grep -qx relay; then
    docker compose -f "$COMPOSE_FILE" exec -T relay sh -lc 'cat /data/security.json 2>/dev/null || true' > "$d/security.json" || true
    [ -s "$d/security.json" ] || rm -f "$d/security.json"
  fi
  echo "备份完成: $d"
}
doctor(){
  echo "=== Coyote Relay Doctor ==="
  echo "模式: ${MODE:-?}"
  echo "地址: ${RELAY_URL:-?}"
  echo "Health: ${HEALTH_URL:-?}"
  echo "Admin: ${ADMIN_URL:-?}"
  echo "Compose: $COMPOSE_FILE"
  echo
  docker compose -f "$COMPOSE_FILE" ps || true
  echo
  echo "[Public health]"
  if command -v curl >/dev/null 2>&1; then
    extra=(); [ "${MODE:-}" = manual-tls ] && extra=(-k)
    curl "${extra[@]}" -v --connect-timeout 5 --max-time 10 "${HEALTH_URL:-}" 2>&1 | tail -n 35 || true
  fi
  echo
  echo "[Recent relay logs]"; docker compose -f "$COMPOSE_FILE" logs relay --tail=60 || true
  echo
  echo "[Recent caddy logs]"; docker compose -f "$COMPOSE_FILE" logs caddy --tail=60 || true
}
show_config(){
  echo "=== 当前部署 ==="; cat .coyote-deploy.env; echo
  echo "=== 运行参数 ==="; cat .env; echo
  echo "=== Caddy ==="; cat Caddyfile.generated; echo
  echo "=== 客户端 official_relay.json ==="; cat generated-client-config/official_relay.json 2>/dev/null || true
}
admin_reset(){
  echo "将把管理员恢复为 admin / admin，并强制下次登录修改密码。黑名单不会删除。"
  read -r -p "确定？ [y/N]: " y
  [[ "$y" =~ ^[Yy]$ ]] || { echo "已取消"; return; }
  docker compose -f "$COMPOSE_FILE" stop relay
  docker compose -f "$COMPOSE_FILE" run --rm relay bun run /app/v4-server.ts --reset-admin
  docker compose -f "$COMPOSE_FILE" up -d relay
  echo "管理员已重置。管理地址: ${ADMIN_URL:-/admin/}"
}
security_export(){
  local out="${1:-security-export-$(date +%Y%m%d-%H%M%S).json}"
  docker compose -f "$COMPOSE_FILE" exec -T relay sh -lc 'cat /data/security.json' > "$out"
  chmod 600 "$out" 2>/dev/null || true
  echo "已导出: $out（包含管理员密码哈希和黑名单，请妥善保管）"
}

menu(){
  while true; do
    cat <<'MENU'
========== Coyote Relay 管理 ==========
1. 查看运行状态
2. 查看全部实时日志
3. 查看 Relay 日志
4. 查看 Caddy 日志
5. 重启服务
6. 上传源码后重建并刷新
7. 一键诊断
8. 查看当前配置
9. 显示管理面板地址
10. 重置管理员密码
11. 导出安全数据
12. 查看证书
13. 立即备份
14. 重新配置部署
15. 停止服务
16. 启动服务
17. 彻底清理
0. 退出
MENU
    read -r -p "请选择: " n
    case "$n" in
      1) "$0" status;; 2) "$0" logs;; 3) "$0" relay-logs;; 4) "$0" caddy-logs;;
      5) "$0" restart;; 6) "$0" reload;; 7) "$0" doctor;; 8) "$0" config;;
      9) "$0" admin;; 10) "$0" admin-reset;; 11) "$0" security-export;; 12) "$0" certs;;
      13) "$0" backup;; 14) "$0" reconfigure;; 15) "$0" stop;; 16) "$0" start;;
      17) "$0" purge;; 0) exit 0;; *) echo "无效选择";;
    esac
    echo
    read -r -p "按 Enter 返回菜单..." _ || true
  done
}

if [ "$#" -eq 0 ]; then menu; exit 0; fi
ACTION="$1"
case "$ACTION" in reconfigure) exec ./deploy.sh ;; *) load_state ;; esac
case "$ACTION" in
  status) docker compose -f "$COMPOSE_FILE" ps ;;
  logs) docker compose -f "$COMPOSE_FILE" logs -f --tail=200 ;;
  relay-logs) docker compose -f "$COMPOSE_FILE" logs -f --tail=200 relay ;;
  caddy-logs) docker compose -f "$COMPOSE_FILE" logs -f --tail=200 caddy ;;
  restart) docker compose -f "$COMPOSE_FILE" restart ;;
  update) docker compose -f "$COMPOSE_FILE" up -d --build ;;
  reload) docker compose -f "$COMPOSE_FILE" up -d --build --force-recreate ;;
  stop) docker compose -f "$COMPOSE_FILE" down ;;
  start) docker compose -f "$COMPOSE_FILE" up -d ;;
  doctor) doctor ;;
  config) show_config ;;
  admin) echo "管理面板: ${ADMIN_URL:-未知}" ;;
  admin-reset) admin_reset ;;
  security-export) security_export "${2:-}" ;;
  certs) echo "站点目录: ${SITE_DIR:-?}"; [ -d "${SITE_DIR:-}/certs" ] && ls -lah "${SITE_DIR}/certs" || true ;;
  backup) backup_now ;;
  purge)
    read -r -p "这会删除容器、Caddy 状态卷和 Relay 安全数据卷（含黑名单/管理员密码）。确定？ [y/N]: " y
    [[ "$y" =~ ^[Yy]$ ]] && docker compose -f "$COMPOSE_FILE" down -v || echo "已取消"
    ;;
  *) echo "用法: $0 {status|logs|relay-logs|caddy-logs|start|stop|restart|update|reload|doctor|config|admin|admin-reset|security-export|certs|backup|reconfigure|purge}"; exit 2 ;;
esac
