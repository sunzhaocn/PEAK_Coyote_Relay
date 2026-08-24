#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"

info(){ printf '\033[1;36m%s\033[0m\n' "$*"; }
ok(){ printf '\033[1;32m%s\033[0m\n' "$*"; }
warn(){ printf '\033[1;33m[WARN] %s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m[ERROR] %s\033[0m\n' "$*" >&2; exit 1; }
ask(){ local q="$1" d="${2:-}" v; if [ -n "$d" ]; then read -r -p "$q [$d]: " v || true; printf '%s' "${v:-$d}"; else read -r -p "$q: " v || true; printf '%s' "$v"; fi; }
yesno(){ local q="$1" d="${2:-N}" v; read -r -p "$q [${d}/$([ "$d" = Y ] && echo N || echo y)]: " v || true; v="${v:-$d}"; [[ "$v" =~ ^[Yy]$ ]]; }

need_docker(){
  command -v docker >/dev/null 2>&1 || die "未检测到 Docker。请先安装 Docker Engine/Desktop。"
  docker compose version >/dev/null 2>&1 || die "未检测到 docker compose 插件。"
  docker info >/dev/null 2>&1 || die "Docker 已安装但 daemon 未运行或当前用户无权限。"
}

http_get(){
  local family="$1" url="$2"
  if command -v curl >/dev/null 2>&1; then
    curl "$family" -fsS --connect-timeout 3 --max-time 6 "$url" 2>/dev/null || true
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=6 "$url" 2>/dev/null || true
  fi
}

detect_ipv4(){
  local v url
  # Public echo services: try several because individual endpoints can be unreachable
  # from some mainland-China/cloud networks.
  for url in \
    https://api4.ipify.org \
    https://ipv4.icanhazip.com \
    https://checkip.amazonaws.com \
    https://4.ident.me \
    https://ifconfig.me/ip; do
    v="$(http_get -4 "$url" | tr -d '[:space:]')"
    if [[ "$v" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then printf '%s' "$v"; return 0; fi
  done

  # Tencent Cloud CVM metadata fallback. It is only reachable from inside a
  # Tencent CVM, so it is harmless on other providers.
  if command -v curl >/dev/null 2>&1; then
    v="$(curl -fsS --connect-timeout 1 --max-time 2 http://metadata.tencentyun.com/latest/meta-data/public-ipv4 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$v" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then printf '%s' "$v"; return 0; fi
  fi

  # DNS resolver fallback.
  if command -v dig >/dev/null 2>&1; then
    v="$(dig +short myip.opendns.com @resolver1.opendns.com 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"
    if [[ "$v" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then printf '%s' "$v"; return 0; fi
  fi
  return 0
}

detect_ipv6(){
  local v url
  for url in https://api6.ipify.org https://ipv6.icanhazip.com https://6.ident.me; do
    v="$(http_get -6 "$url" | tr -d '[:space:]')"
    if [[ "$v" == *:* ]]; then printf '%s' "$v"; return 0; fi
  done
  return 0
}

copy_if_different(){
  local src="$1" dst="$2" label="${3:-文件}"
  [ -f "$src" ] || die "$label 不存在：$src"
  if [ -e "$dst" ] && [[ "$src" -ef "$dst" ]]; then
    info "$label 已位于目标目录，跳过重复复制：$dst"
    return 0
  fi
  cp -f -- "$src" "$dst"
}

validate_manual_certificate(){
  local cert="$1" key="$2" host="$3"
  if ! command -v openssl >/dev/null 2>&1; then
    warn "未检测到 openssl，跳过证书内容校验；Caddy 启动时仍会再次验证。"
    return 0
  fi

  openssl x509 -in "$cert" -noout >/dev/null 2>&1 || die "证书不是可读取的 X.509 PEM/CRT：$cert"
  openssl pkey -in "$key" -noout >/dev/null 2>&1 || die "私钥不是可读取的 PEM 私钥：$key"

  local cert_pub key_pub
  cert_pub="$(openssl x509 -in "$cert" -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | openssl dgst -sha256 2>/dev/null | awk '{print $NF}')"
  key_pub="$(openssl pkey -in "$key" -pubout -outform DER 2>/dev/null | openssl dgst -sha256 2>/dev/null | awk '{print $NF}')"
  [ -n "$cert_pub" ] && [ "$cert_pub" = "$key_pub" ] || die "证书与私钥不匹配，请确认没有拿错 key 文件。"

  openssl x509 -checkend 0 -noout -in "$cert" >/dev/null 2>&1 || die "证书已经过期或当前时间不在证书有效期内。"
  if ! openssl x509 -checkend 604800 -noout -in "$cert" >/dev/null 2>&1; then
    warn "证书将在 7 天内过期，建议尽快续期。"
  fi

  if openssl x509 -help 2>&1 | grep -q -- '-checkhost'; then
    if is_ipv4 "$host" || is_ipv6 "$host"; then
      if ! openssl x509 -checkip "$host" -noout -in "$cert" >/dev/null 2>&1; then
        warn "证书 SAN 未匹配 IP：$host；手机端可能拒绝 WSS。"
      else
        ok "证书 SAN 已匹配 IP：$host"
      fi
    else
      if ! openssl x509 -checkhost "$host" -noout -in "$cert" >/dev/null 2>&1; then
        die "证书 SAN/CN 未匹配域名：$host。请换成签发给该域名的证书。"
      else
        ok "证书已匹配域名：$host"
      fi
    fi
  else
    warn "当前 openssl 不支持 -checkhost/-checkip，跳过 SAN 主机名校验；Caddy/客户端仍会进行 TLS 校验。"
  fi
}

normalize_host(){
  local h="$1"
  h="${h#http://}"; h="${h#https://}"; h="${h#ws://}"; h="${h#wss://}"
  h="${h%%/*}"; h="${h#[}"; h="${h%]}"; printf '%s' "${h//[[:space:]]/}"
}
url_host(){ local h="$1"; if [[ "$h" == *:* ]]; then printf '[%s]' "$h"; else printf '%s' "$h"; fi; }
safe_name(){ printf '%s' "$1" | tr ':/' '__' | sed 's/[^A-Za-z0-9._-]/_/g' | cut -c1-120; }
is_ipv4(){ [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }
is_ipv6(){ [[ "$1" == *:* ]]; }
is_domain(){ [[ "$1" =~ ^[A-Za-z0-9.-]+$ ]] && ! is_ipv4 "$1"; }
valid_port(){ [[ "$1" =~ ^[0-9]+$ ]] && (( $1 >= 1 && $1 <= 65535 )); }

port_busy(){
  local p="$1"
  if command -v ss >/dev/null 2>&1; then ss -lnt 2>/dev/null | awk '{print $4}' | grep -Eq "(^|:|\])${p}$" && return 0 || return 1; fi
  if command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && return 0 || return 1; fi
  if command -v netstat >/dev/null 2>&1; then netstat -an 2>/dev/null | grep -E "[.:]${p}[[:space:]].*LISTEN" >/dev/null && return 0 || return 1; fi
  return 1
}

dns_values(){
  local host="$1" type="$2"
  if command -v dig >/dev/null 2>&1; then dig +short "$type" "$host" 2>/dev/null | sed '/^$/d'; return; fi
  if command -v host >/dev/null 2>&1; then
    if [ "$type" = A ]; then host -t A "$host" 2>/dev/null | awk '/has address/{print $4}'; else host -t AAAA "$host" 2>/dev/null | awk '/has IPv6 address/{print $5}'; fi
    return
  fi
  if command -v getent >/dev/null 2>&1; then
    if [ "$type" = A ]; then getent ahostsv4 "$host" 2>/dev/null | awk '{print $1}' | sort -u; else getent ahostsv6 "$host" 2>/dev/null | awk '{print $1}' | sort -u; fi
  fi
}

find_cert_pair(){
  local dir="$1" cert key pair c k
  [ -d "$dir" ] || return 1
  for pair in 'fullchain.pem:privkey.pem' 'cert.pem:key.pem' 'certificate.pem:private.key' 'server.crt:server.key' 'tls.crt:tls.key'; do
    c="${pair%%:*}"; k="${pair#*:}"
    if [ -s "$dir/$c" ] && [ -s "$dir/$k" ]; then printf '%s\n%s\n' "$dir/$c" "$dir/$k"; return 0; fi
  done
  cert="$(find "$dir" -maxdepth 1 -type f \( -iname '*.crt' -o -iname '*.pem' \) ! -iname '*key*' ! -iname 'privkey*' | head -n1 || true)"
  key="$(find "$dir" -maxdepth 1 -type f \( -iname '*.key' -o -iname '*key*.pem' -o -iname 'privkey*.pem' \) | head -n1 || true)"
  [ -n "$cert" ] && [ -n "$key" ] && printf '%s\n%s\n' "$cert" "$key" && return 0
  return 1
}

backup_config(){
  if [ -f .coyote-deploy.env ] || [ -f Caddyfile.generated ] || [ -f .env ]; then
    local ts="$(date +%Y%m%d-%H%M%S)" d="backups/$ts"
    mkdir -p "$d"
    cp -f .coyote-deploy.env Caddyfile.generated .env "$d/" 2>/dev/null || true
    [ -d sites ] && cp -a sites "$d/" 2>/dev/null || true
    info "旧配置已备份到 $d"
  fi
}

stop_existing(){
  if [ -f .coyote-deploy.env ]; then
    local old_compose
    old_compose="$(awk -F= '$1=="COMPOSE_FILE"{print $2}' .coyote-deploy.env | tail -n1)"
    if [ -n "$old_compose" ] && [ -f "$old_compose" ]; then docker compose -f "$old_compose" down >/dev/null 2>&1 || true; fi
  fi
}

write_caddy(){
  local mode="$1" host="$2" site="$3" relay_port="$4"
  local address headers tls_line=""
  headers='        X-Content-Type-Options "nosniff"\n        Referrer-Policy "no-referrer"\n        -Server'
  case "$mode" in
    auto-tls)
      address="$host"
      cat > Caddyfile.generated <<CADDY
$address {
    encode zstd gzip
    reverse_proxy relay:$relay_port {
        header_up X-Coyote-Client-IP {remote_host}
    }
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        -Server
    }
    log {
        output stdout
        format console
    }
}
CADDY
      ;;
    manual-tls)
      address="https://$(url_host "$host")"
      cat > Caddyfile.generated <<CADDY
$address {
    tls /srv/sites/$site/certs/fullchain.pem /srv/sites/$site/certs/privkey.pem
    encode zstd gzip
    reverse_proxy relay:$relay_port {
        header_up X-Coyote-Client-IP {remote_host}
    }
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        -Server
    }
    log {
        output stdout
        format console
    }
}
CADDY
      ;;
    plain)
      address="http://$(url_host "$host")"
      cat > Caddyfile.generated <<CADDY
$address {
    encode zstd gzip
    reverse_proxy relay:$relay_port {
        header_up X-Coyote-Client-IP {remote_host}
    }
    header {
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        -Server
    }
    log {
        output stdout
        format console
    }
}
CADDY
      ;;
  esac
}

open_firewall(){
  local mode="$1" port="$2"
  if ! yesno "是否尝试自动放行系统防火墙端口？云厂商安全组仍需你在控制台放行" N; then return; fi
  if command -v ufw >/dev/null 2>&1; then
    if [ "$mode" = auto-tls ]; then sudo ufw allow 80/tcp || true; sudo ufw allow 443/tcp || true; else sudo ufw allow "$port/tcp" || true; fi
  elif command -v firewall-cmd >/dev/null 2>&1; then
    if [ "$mode" = auto-tls ]; then sudo firewall-cmd --permanent --add-port=80/tcp || true; sudo firewall-cmd --permanent --add-port=443/tcp || true; else sudo firewall-cmd --permanent --add-port="$port/tcp" || true; fi
    sudo firewall-cmd --reload || true
  else
    warn "未检测到 ufw/firewalld；请手动放行所需 TCP 端口。"
  fi
}

need_docker
mkdir -p sites generated-client-config backups

info "=== Coyote DG-LAB Relay 交互式部署 ==="
IPV4="$(detect_ipv4)"; IPV6="$(detect_ipv6)"
printf '检测到公网 IPv4: %s\n' "${IPV4:-无}"
printf '检测到公网 IPv6: %s\n' "${IPV6:-无}"

DOMAIN="$(ask '请输入绑定域名；直接回车则跳过域名并使用服务器 IP' '')"
DOMAIN="$(normalize_host "$DOMAIN")"
HOST=""
HOST_KIND=""
if [ -n "$DOMAIN" ]; then
  [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "域名格式无效：$DOMAIN"
  HOST="$DOMAIN"; HOST_KIND="domain"
  A_REC="$(dns_values "$DOMAIN" A | tr '\n' ' ' || true)"; AAAA_REC="$(dns_values "$DOMAIN" AAAA | tr '\n' ' ' || true)"
  printf 'DNS A:    %s\n' "${A_REC:-未解析/无法检测}"
  printf 'DNS AAAA: %s\n' "${AAAA_REC:-未解析/无法检测}"
  if [ -z "$IPV4" ] && [ -n "$A_REC" ]; then
    DNS_IPV4_HINT="$(printf '%s\n' "$A_REC" | awk '{print $1}')"
    if is_ipv4 "$DNS_IPV4_HINT"; then
      info "公网 IPv4 探测服务未返回结果；域名 DNS A 当前指向：$DNS_IPV4_HINT（请以云厂商控制台为最终准确信息）"
    fi
  fi
  [ -n "$IPV4" ] && [ -n "$A_REC" ] && [[ " $A_REC " != *" $IPV4 "* ]] && warn "域名 A 记录目前未包含本机公网 IPv4 $IPV4。自动证书签发前应确认 DNS。"
  [ -n "$IPV6" ] && [ -n "$AAAA_REC" ] && [[ " $AAAA_REC " != *" $IPV6 "* ]] && warn "域名 AAAA 记录目前未包含本机公网 IPv6 $IPV6。"
else
  choices=()
  [ -n "$IPV4" ] && choices+=("IPv4:$IPV4")
  [ -n "$IPV6" ] && choices+=("IPv6:$IPV6")
  [ ${#choices[@]} -gt 0 ] || warn "未自动检测到公网 IP，可手动输入。"
  echo "选择公开地址："
  idx=1; for c in "${choices[@]}"; do echo "  $idx) $c"; idx=$((idx+1)); done
  echo "  $idx) 手动输入 IP/主机名"
  default_choice=1
  sel="$(ask '选择' "$default_choice")"
  if [[ "$sel" =~ ^[0-9]+$ ]] && (( sel>=1 && sel<=${#choices[@]} )); then
    item="${choices[$((sel-1))]}"; HOST="${item#*:}"
  else
    HOST="$(normalize_host "$(ask '请输入服务器 IPv4 / IPv6 / 主机名' '')")"
  fi
  [ -n "$HOST" ] || die "没有可用的公开地址。"
  if is_ipv4 "$HOST"; then HOST_KIND="ipv4"; elif is_ipv6 "$HOST"; then HOST_KIND="ipv6"; else HOST_KIND="host"; fi
fi

SITE="$(safe_name "$HOST")"
SITE_DIR="sites/$SITE"; CERT_DIR="$SITE_DIR/certs"
mkdir -p "$CERT_DIR"
cat > "$SITE_DIR/README.txt" <<TXT
Coyote Relay 站点：$HOST

手动证书可放入本目录 certs/，重新运行 deploy 即会扫描。推荐文件名：
  fullchain.pem + privkey.pem
也支持：
  cert.pem + key.pem
  server.crt + server.key
  tls.crt + tls.key

证书必须为 PEM/CRT + 私钥格式。PFX/P12 请先转换。
TXT

PAIR="$(find_cert_pair "$CERT_DIR" 2>/dev/null || true)"
if [ -n "$PAIR" ]; then
  EXIST_CERT="$(printf '%s\n' "$PAIR" | sed -n '1p')"; EXIST_KEY="$(printf '%s\n' "$PAIR" | sed -n '2p')"
  info "已在 $CERT_DIR 自动发现证书：$(basename "$EXIST_CERT") + $(basename "$EXIST_KEY")"
else
  EXIST_CERT=""; EXIST_KEY=""
fi

echo "TLS / 证书模式："
if [ "$HOST_KIND" = domain ]; then
  echo "  1) 自动证书（推荐；Caddy 自动申请/续期，需要 DNS 正确且公网 80/443 可达）"
  echo "  2) 手动证书（自动扫描 $CERT_DIR，也可输入证书路径）"
  echo "  3) 无证书（仅 WS，不是 WSS）"
  TLS_CHOICE="$(ask '选择' 1)"
else
  echo "  1) 手动证书（证书必须包含该 IP/主机名 SAN；否则手机会报证书错误）"
  echo "  2) 无证书（WS，默认）"
  TLS_CHOICE="$(ask '选择' 2)"
  [ "$TLS_CHOICE" = 1 ] && TLS_CHOICE=2 || TLS_CHOICE=3
fi

MODE=""; PUBLIC_PORT=""; CERT_SOURCE=""; KEY_SOURCE=""
case "$TLS_CHOICE" in
  1) MODE="auto-tls"; PUBLIC_PORT=443 ;;
  2)
    MODE="manual-tls"
    if [ -n "$EXIST_CERT" ]; then
      CERT_SOURCE="$EXIST_CERT"; KEY_SOURCE="$EXIST_KEY"
      if ! yesno "使用自动发现的证书？" Y; then CERT_SOURCE=""; KEY_SOURCE=""; fi
    fi
    if [ -z "$CERT_SOURCE" ]; then
      CPATH="$(ask "输入证书文件或证书目录路径；回车重新扫描 $CERT_DIR" '')"
      if [ -z "$CPATH" ]; then
        PAIR="$(find_cert_pair "$CERT_DIR" 2>/dev/null || true)"
        [ -n "$PAIR" ] || die "未发现证书。请先把证书放入 $CERT_DIR 后重试，或输入证书路径。"
        CERT_SOURCE="$(printf '%s\n' "$PAIR" | sed -n '1p')"; KEY_SOURCE="$(printf '%s\n' "$PAIR" | sed -n '2p')"
      elif [ -d "$CPATH" ]; then
        PAIR="$(find_cert_pair "$CPATH" 2>/dev/null || true)"; [ -n "$PAIR" ] || die "目录内未找到证书+私钥组合。"
        CERT_SOURCE="$(printf '%s\n' "$PAIR" | sed -n '1p')"; KEY_SOURCE="$(printf '%s\n' "$PAIR" | sed -n '2p')"
      else
        [ -f "$CPATH" ] || die "证书文件不存在：$CPATH"
        CERT_SOURCE="$CPATH"; KEY_SOURCE="$(ask '请输入私钥路径' '')"; [ -f "$KEY_SOURCE" ] || die "私钥文件不存在：$KEY_SOURCE"
      fi
    fi
    validate_manual_certificate "$CERT_SOURCE" "$KEY_SOURCE" "$HOST"
    copy_if_different "$CERT_SOURCE" "$CERT_DIR/fullchain.pem" "证书"
    copy_if_different "$KEY_SOURCE" "$CERT_DIR/privkey.pem" "私钥"
    chmod 600 "$CERT_DIR/privkey.pem" 2>/dev/null || true
    PUBLIC_PORT="$(ask '设置公网 WSS 端口' 443)"; valid_port "$PUBLIC_PORT" || die "端口无效：$PUBLIC_PORT"
    warn "如果这是自签证书或证书 SAN 不包含 $HOST，DG-LAB 手机端可能拒绝连接。"
    ;;
  3) MODE="plain"; PUBLIC_PORT="$(ask '设置公网 WS 端口' 80)"; valid_port "$PUBLIC_PORT" || die "端口无效：$PUBLIC_PORT" ;;
  *) die "无效选择" ;;
esac

RELAY_INTERNAL_PORT="$(ask 'Relay 容器内部端口（一般无需修改）' 9998)"; valid_port "$RELAY_INTERNAL_PORT" || die "内部端口无效"
RELAY_NAME="$(ask '中继显示名称' '北京官方中继')"

MAX_CONNECTIONS=4000; MAX_CONNECTIONS_PER_IP=64; MAX_CLIENTS_PER_CONTROLLER=16; MAX_MESSAGE_BYTES=262144; MAX_MESSAGES_PER_SECOND=120; IDLE_TIMEOUT=300000; LOG_LEVEL=info
ADMIN_USER=admin; ADMIN_INITIAL_PASSWORD=admin; ADMIN_SESSION_HOURS=8; ADMIN_LOGIN_MAX_ATTEMPTS=5; ADMIN_LOGIN_WINDOW_MS=600000; ADMIN_LOGIN_LOCKOUT_MS=900000; ADMIN_API_MAX_PER_MINUTE=180; ADMIN_GLOBAL_LOGIN_MAX_PER_MINUTE=60; MAX_WS_HANDSHAKES_PER_MINUTE=240; ADMIN_ALLOW_INSECURE_HTTP=false
if yesno "是否修改高级防滥用参数？" N; then
  MAX_CONNECTIONS="$(ask '最大总 WebSocket 连接数' "$MAX_CONNECTIONS")"
  MAX_CONNECTIONS_PER_IP="$(ask '单公网 IP 最大并发连接数' "$MAX_CONNECTIONS_PER_IP")"
  MAX_CLIENTS_PER_CONTROLLER="$(ask '每个 Controller 最大手机数' "$MAX_CLIENTS_PER_CONTROLLER")"
  MAX_MESSAGE_BYTES="$(ask '单条消息最大字节数' "$MAX_MESSAGE_BYTES")"
  MAX_MESSAGES_PER_SECOND="$(ask '单连接每秒最大消息数' "$MAX_MESSAGES_PER_SECOND")"
  IDLE_TIMEOUT="$(ask '无手机 Controller 回收时间(ms)' "$IDLE_TIMEOUT")"
  LOG_LEVEL="$(ask '日志级别(debug/info/warn/error)' "$LOG_LEVEL")"
  ADMIN_LOGIN_MAX_ATTEMPTS="$(ask '管理后台：登录窗口内最大失败次数' "$ADMIN_LOGIN_MAX_ATTEMPTS")"
  ADMIN_LOGIN_LOCKOUT_MS="$(ask '管理后台：触发后锁定时间(ms)' "$ADMIN_LOGIN_LOCKOUT_MS")"
  ADMIN_API_MAX_PER_MINUTE="$(ask '管理后台：单 IP 每分钟 API 上限' "$ADMIN_API_MAX_PER_MINUTE")"
  ADMIN_GLOBAL_LOGIN_MAX_PER_MINUTE="$(ask '管理后台：全局每分钟登录请求上限' "$ADMIN_GLOBAL_LOGIN_MAX_PER_MINUTE")"
  MAX_WS_HANDSHAKES_PER_MINUTE="$(ask 'Relay：单 IP 每分钟 WebSocket 握手上限' "$MAX_WS_HANDSHAKES_PER_MINUTE")"
fi

case "$MODE" in
  auto-tls) COMPOSE_FILE="compose.auto-tls.yaml"; SCHEME=wss; CLIENT_PORT=443; HEALTH_SCHEME=https ;;
  manual-tls) COMPOSE_FILE="compose.manual-tls.yaml"; SCHEME=wss; CLIENT_PORT="$PUBLIC_PORT"; HEALTH_SCHEME=https ;;
  plain) COMPOSE_FILE="compose.plain.yaml"; SCHEME=ws; CLIENT_PORT="$PUBLIC_PORT"; HEALTH_SCHEME=http ;;
esac
H="$(url_host "$HOST")"
if { [ "$SCHEME" = wss ] && [ "$CLIENT_PORT" = 443 ]; } || { [ "$SCHEME" = ws ] && [ "$CLIENT_PORT" = 80 ]; }; then RELAY_URL="$SCHEME://$H"; HEALTH_URL="$HEALTH_SCHEME://$H/healthz"; ADMIN_URL="$HEALTH_SCHEME://$H"; else RELAY_URL="$SCHEME://$H:$CLIENT_PORT"; HEALTH_URL="$HEALTH_SCHEME://$H:$CLIENT_PORT/healthz"; ADMIN_URL="$HEALTH_SCHEME://$H:$CLIENT_PORT"; fi
if [ "$MODE" = plain ]; then
  warn "当前是无 TLS 的 WS/HTTP 模式。为避免管理员密码明文传输，管理面板默认禁止登录。"
  if yesno "是否仍允许通过 HTTP 登录管理面板？仅建议封闭测试网络使用" N; then ADMIN_ALLOW_INSECURE_HTTP=true; fi
fi

backup_config
write_caddy "$MODE" "$HOST" "$SITE" "$RELAY_INTERNAL_PORT"
cat > .env <<ENV
RELAY_INTERNAL_PORT=$RELAY_INTERNAL_PORT
PUBLIC_PORT=$PUBLIC_PORT
LOG_LEVEL=$LOG_LEVEL
MAX_CONNECTIONS=$MAX_CONNECTIONS
MAX_CONNECTIONS_PER_IP=$MAX_CONNECTIONS_PER_IP
MAX_CLIENTS_PER_CONTROLLER=$MAX_CLIENTS_PER_CONTROLLER
MAX_MESSAGE_BYTES=$MAX_MESSAGE_BYTES
MAX_MESSAGES_PER_SECOND=$MAX_MESSAGES_PER_SECOND
MAX_WS_HANDSHAKES_PER_MINUTE=$MAX_WS_HANDSHAKES_PER_MINUTE
IDLE_TIMEOUT=$IDLE_TIMEOUT
ADMIN_USER=$ADMIN_USER
ADMIN_INITIAL_PASSWORD=$ADMIN_INITIAL_PASSWORD
ADMIN_SESSION_HOURS=$ADMIN_SESSION_HOURS
ADMIN_LOGIN_MAX_ATTEMPTS=$ADMIN_LOGIN_MAX_ATTEMPTS
ADMIN_LOGIN_WINDOW_MS=$ADMIN_LOGIN_WINDOW_MS
ADMIN_LOGIN_LOCKOUT_MS=$ADMIN_LOGIN_LOCKOUT_MS
ADMIN_API_MAX_PER_MINUTE=$ADMIN_API_MAX_PER_MINUTE
ADMIN_GLOBAL_LOGIN_MAX_PER_MINUTE=$ADMIN_GLOBAL_LOGIN_MAX_PER_MINUTE
ADMIN_ALLOW_INSECURE_HTTP=$ADMIN_ALLOW_INSECURE_HTTP
ENV
cat > .coyote-deploy.env <<ENV
COMPOSE_FILE=$COMPOSE_FILE
MODE=$MODE
HOST=$HOST
HOST_KIND=$HOST_KIND
SITE_DIR=$SITE_DIR
PUBLIC_PORT=$PUBLIC_PORT
RELAY_INTERNAL_PORT=$RELAY_INTERNAL_PORT
RELAY_URL=$RELAY_URL
HEALTH_URL=$HEALTH_URL
RELAY_NAME=$RELAY_NAME
ADMIN_URL=$ADMIN_URL
DETECTED_IPV4=$IPV4
DETECTED_IPV6=$IPV6
ENV
cat > "$SITE_DIR/site.env" <<ENV
HOST=$HOST
HOST_KIND=$HOST_KIND
MODE=$MODE
PUBLIC_PORT=$PUBLIC_PORT
RELAY_INTERNAL_PORT=$RELAY_INTERNAL_PORT
RELAY_URL=$RELAY_URL
ADMIN_URL=$ADMIN_URL
DETECTED_IPV4=$IPV4
DETECTED_IPV6=$IPV6
UPDATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ENV
cat > generated-client-config/official_relay.json <<JSON
{
  "name": "${RELAY_NAME//\"/\\\"}",
  "url": "$RELAY_URL"
}
JSON

info "验证 Docker Compose 配置..."
docker compose -f "$COMPOSE_FILE" config -q
info "验证 Caddy 配置..."
docker run --rm -v "$ROOT/Caddyfile.generated:/etc/caddy/Caddyfile:ro" -v "$ROOT/sites:/srv/sites:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile >/dev/null

if [ -f .coyote-deploy.env ]; then stop_existing; fi
CHECK_PORTS=()
if [ "$MODE" = auto-tls ]; then CHECK_PORTS=(80 443); else CHECK_PORTS=("$PUBLIC_PORT"); fi
for p in "${CHECK_PORTS[@]}"; do if port_busy "$p"; then warn "宿主机 TCP $p 已被其他程序占用。"; yesno "仍继续部署？" N || die "请释放端口 $p 后重试。"; fi; done

open_firewall "$MODE" "$PUBLIC_PORT"

info "构建并启动 Relay..."
docker compose -f "$COMPOSE_FILE" up -d --build
info "容器状态："
docker compose -f "$COMPOSE_FILE" ps

info "健康检查：$HEALTH_URL"
HEALTH_OK=0
for _ in $(seq 1 45); do
  if command -v curl >/dev/null 2>&1; then
    CURL_TLS=(); [ "$MODE" = manual-tls ] && CURL_TLS=(-k)
    if curl "${CURL_TLS[@]}" -fsS --connect-timeout 3 --max-time 5 "$HEALTH_URL" >/tmp/coyote-health.$$ 2>/dev/null; then cat /tmp/coyote-health.$$; rm -f /tmp/coyote-health.$$; HEALTH_OK=1; break; fi
  fi
  sleep 2
done
[ "$HEALTH_OK" = 1 ] || warn "自动健康检查未成功。若为自动证书模式，首次签发可能需要更久；请运行 ./manage.sh logs 和 ./manage.sh doctor。"

ok "部署完成"
echo "模式:       $MODE"
echo "公开地址:   $HOST"
echo "客户端地址: $RELAY_URL"
echo "健康检查:   $HEALTH_URL"
echo "管理面板:   $ADMIN_URL"
echo "站点目录:   $SITE_DIR"
echo "客户端配置: generated-client-config/official_relay.json"
echo
echo "管理后台初始账号: admin"
echo "管理后台初始密码: admin"
warn "首次登录管理面板会强制修改初始密码。部署完成后请立即登录并改成高强度密码。"
if [ "$MODE" = auto-tls ]; then warn "自动证书要求域名 DNS 指向本机，并在云安全组/系统防火墙放行 TCP 80/443。"; fi
if [ "$MODE" = plain ]; then warn "当前为无证书 WS。公网正式使用更推荐域名 + WSS。"; fi
