param()
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Info([string]$s){ Write-Host $s -ForegroundColor Cyan }
function Ok([string]$s){ Write-Host $s -ForegroundColor Green }
function Warn([string]$s){ Write-Host "[WARN] $s" -ForegroundColor Yellow }
function Ask([string]$q,[string]$default=''){
    if($default){ $v=Read-Host "$q [$default]"; if([string]::IsNullOrWhiteSpace($v)){return $default}; return $v.Trim() }
    return (Read-Host $q).Trim()
}
function Confirm([string]$q,[bool]$default=$false){
    $hint = if($default){'Y/n'}else{'y/N'}
    $v=(Read-Host "$q [$hint]").Trim()
    if([string]::IsNullOrWhiteSpace($v)){return $default}
    return $v -match '^[Yy]$'
}
function Write-Utf8NoBom([string]$Path,[string]$Content){
    $utf8=New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot $Path),$Content,$utf8)
}
function Normalize-Host([string]$h){
    $h=$h.Trim() -replace '^https?://','' -replace '^wss?://',''
    $h=($h -split '/')[0]
    if($h.StartsWith('[') -and $h.EndsWith(']')){$h=$h.Substring(1,$h.Length-2)}
    return $h.Trim()
}
function Url-Host([string]$h){ if($h.Contains(':')){return "[$h]"}; return $h }
function Safe-Name([string]$h){
    $s=$h -replace '[:/\\]','_' -replace '[^A-Za-z0-9._-]','_'
    if($s.Length -gt 120){$s=$s.Substring(0,120)}
    return $s
}
function Valid-Port($p){ try{$n=[int]$p; return $n -ge 1 -and $n -le 65535}catch{return $false} }
function Get-PublicIP([int]$version){
    $urls = if($version -eq 4){
        @('https://api4.ipify.org','https://ipv4.icanhazip.com','https://checkip.amazonaws.com','https://4.ident.me','https://ifconfig.me/ip')
    } else {
        @('https://api6.ipify.org','https://ipv6.icanhazip.com','https://6.ident.me')
    }
    foreach($url in $urls){
        try{
            if(Get-Command curl.exe -ErrorAction SilentlyContinue){
                $flag=if($version -eq 4){'-4'}else{'-6'}
                $v=(& curl.exe $flag -fsS --connect-timeout 3 --max-time 6 $url 2>$null).Trim()
            } else { $v=(Invoke-RestMethod -Uri $url -TimeoutSec 6).ToString().Trim() }
            if($version -eq 4 -and $v -match '^([0-9]{1,3}\.){3}[0-9]{1,3}$'){return $v}
            if($version -eq 6 -and $v.Contains(':')){return $v}
        }catch{}
    }
    if($version -eq 4){
        # Tencent Cloud CVM metadata fallback; unreachable on other providers.
        try{
            if(Get-Command curl.exe -ErrorAction SilentlyContinue){
                $v=(& curl.exe -fsS --connect-timeout 1 --max-time 2 'http://metadata.tencentyun.com/latest/meta-data/public-ipv4' 2>$null).Trim()
            } else { $v=(Invoke-RestMethod -Uri 'http://metadata.tencentyun.com/latest/meta-data/public-ipv4' -TimeoutSec 2).ToString().Trim() }
            if($v -match '^([0-9]{1,3}\.){3}[0-9]{1,3}$'){return $v}
        }catch{}
    }
    return ''
}
function Copy-IfDifferent([string]$Source,[string]$Destination,[string]$Label='文件'){
    if(-not(Test-Path $Source -PathType Leaf)){throw "$Label 不存在：$Source"}
    $src=(Resolve-Path $Source).Path
    if(Test-Path $Destination -PathType Leaf){
        $dst=(Resolve-Path $Destination).Path
        if([string]::Equals($src,$dst,[StringComparison]::OrdinalIgnoreCase)){
            Info "$Label 已位于目标目录，跳过重复复制：$Destination"
            return
        }
    }
    Copy-Item $Source $Destination -Force
}
function Test-PortBusy([int]$p){
    try{return [bool](Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)}catch{return $false}
}
function Find-CertPair([string]$dir){
    if(-not(Test-Path $dir -PathType Container)){return $null}
    $pairs=@(
        @('fullchain.pem','privkey.pem'),@('cert.pem','key.pem'),@('certificate.pem','private.key'),
        @('server.crt','server.key'),@('tls.crt','tls.key')
    )
    foreach($pair in $pairs){
        $c=Join-Path $dir $pair[0]; $k=Join-Path $dir $pair[1]
        if((Test-Path $c -PathType Leaf) -and (Test-Path $k -PathType Leaf)){return @($c,$k)}
    }
    $cert=Get-ChildItem $dir -File -ErrorAction SilentlyContinue | Where-Object {($_.Extension -in '.crt','.pem') -and $_.Name -notmatch 'key'} | Select-Object -First 1
    $key=Get-ChildItem $dir -File -ErrorAction SilentlyContinue | Where-Object {($_.Extension -eq '.key') -or ($_.Name -match 'key.*\.pem$') -or ($_.Name -match '^privkey.*\.pem$')} | Select-Object -First 1
    if($cert -and $key){return @($cert.FullName,$key.FullName)}
    return $null
}
function Backup-Config(){
    if((Test-Path '.coyote-deploy.env') -or (Test-Path 'Caddyfile.generated') -or (Test-Path '.env')){
        $ts=Get-Date -Format 'yyyyMMdd-HHmmss'; $d=Join-Path 'backups' $ts; New-Item -ItemType Directory -Force $d|Out-Null
        foreach($f in '.coyote-deploy.env','Caddyfile.generated','.env'){if(Test-Path $f){Copy-Item $f $d -Force}}
        if(Test-Path sites){Copy-Item sites (Join-Path $d 'sites') -Recurse -Force}
        Info "旧配置已备份到 $d"
    }
}
function Stop-Existing(){
    if(Test-Path '.coyote-deploy.env'){
        $line=Get-Content '.coyote-deploy.env' | Where-Object {$_ -like 'COMPOSE_FILE=*'} | Select-Object -Last 1
        if($line){$f=$line.Substring('COMPOSE_FILE='.Length); if(Test-Path $f){docker compose -f $f down 2>$null | Out-Null}}
    }
}
function Write-Caddy([string]$mode,[string]$host,[string]$site,[int]$relayPort){
    $uh=Url-Host $host
    if($mode -eq 'auto-tls'){
$content=@"
$host {
    encode zstd gzip
    reverse_proxy relay:$relayPort {
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
"@
    } elseif($mode -eq 'manual-tls'){
$content=@"
https://$uh {
    tls /srv/sites/$site/certs/fullchain.pem /srv/sites/$site/certs/privkey.pem
    encode zstd gzip
    reverse_proxy relay:$relayPort {
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
"@
    } else {
$content=@"
http://$uh {
    encode zstd gzip
    reverse_proxy relay:$relayPort {
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
"@
    }
    Write-Utf8NoBom 'Caddyfile.generated' $content
}

if(-not(Get-Command docker -ErrorAction SilentlyContinue)){throw '未检测到 Docker。请先安装 Docker Desktop/Engine。'}
docker compose version | Out-Null
docker info | Out-Null
New-Item -ItemType Directory -Force sites,generated-client-config,backups|Out-Null

Info '=== Coyote DG-LAB Relay 交互式部署 ==='
$ipv4=Get-PublicIP 4; $ipv6=Get-PublicIP 6
Write-Host "检测到公网 IPv4: $(if($ipv4){$ipv4}else{'无'})"
Write-Host "检测到公网 IPv6: $(if($ipv6){$ipv6}else{'无'})"

$domain=Normalize-Host (Ask '请输入绑定域名；直接回车则跳过域名并使用服务器 IP')
$host=''; $hostKind=''
if($domain){
    if($domain -notmatch '^[A-Za-z0-9.-]+$'){throw "域名格式无效：$domain"}
    $host=$domain; $hostKind='domain'
    try{
        $a=(Resolve-DnsName $domain -Type A -ErrorAction SilentlyContinue).IPAddress | Where-Object {$_}
        $aaaa=(Resolve-DnsName $domain -Type AAAA -ErrorAction SilentlyContinue).IPAddress | Where-Object {$_}
        Write-Host "DNS A:    $(if($a){$a -join ', '}else{'未解析'})"
        Write-Host "DNS AAAA: $(if($aaaa){$aaaa -join ', '}else{'未解析'})"
        if($ipv4 -and $a -and $a -notcontains $ipv4){Warn "域名 A 记录未包含本机公网 IPv4 $ipv4"}
        if($ipv6 -and $aaaa -and $aaaa -notcontains $ipv6){Warn "域名 AAAA 记录未包含本机公网 IPv6 $ipv6"}
    }catch{Warn 'DNS 检测失败，可继续部署，但自动证书前请确认解析正确。'}
}else{
    $opts=@(); if($ipv4){$opts += "IPv4:$ipv4"}; if($ipv6){$opts += "IPv6:$ipv6"}
    Write-Host '选择公开地址：'
    for($i=0;$i -lt $opts.Count;$i++){Write-Host "  $($i+1)) $($opts[$i])"}
    Write-Host "  $($opts.Count+1)) 手动输入 IP/主机名"
    $sel=[int](Ask '选择' '1')
    if($sel -ge 1 -and $sel -le $opts.Count){$host=($opts[$sel-1] -split ':',2)[1]}
    else{$host=Normalize-Host (Ask '请输入服务器 IPv4 / IPv6 / 主机名')}
    if(-not $host){throw '没有可用公开地址'}
    if($host -match '^([0-9]{1,3}\.){3}[0-9]{1,3}$'){$hostKind='ipv4'}elseif($host.Contains(':')){$hostKind='ipv6'}else{$hostKind='host'}
}

$site=Safe-Name $host; $siteDir=Join-Path 'sites' $site; $certDir=Join-Path $siteDir 'certs'
New-Item -ItemType Directory -Force $certDir|Out-Null
$siteReadme=@"
Coyote Relay 站点：$host

手动证书放入 certs 后重新执行 deploy.cmd/deploy.ps1 会自动扫描。
推荐：fullchain.pem + privkey.pem
兼容：cert.pem + key.pem、server.crt + server.key、tls.crt + tls.key
证书需为 PEM/CRT + 私钥；PFX/P12 请先转换。
"@
Write-Utf8NoBom (Join-Path $siteDir 'README.txt') $siteReadme
$found=Find-CertPair $certDir
if($found){Info "已自动发现证书：$([IO.Path]::GetFileName($found[0])) + $([IO.Path]::GetFileName($found[1]))"}

Write-Host 'TLS / 证书模式：'
if($hostKind -eq 'domain'){
    Write-Host '  1) 自动证书（推荐，Caddy 自动申请/续期，需要公网 80/443）'
    Write-Host "  2) 手动证书（自动扫描 $certDir，也可输入路径）"
    Write-Host '  3) 无证书（WS）'
    $tlsChoice=Ask '选择' '1'
}else{
    Write-Host '  1) 手动证书（证书必须包含该 IP/主机名 SAN）'
    Write-Host '  2) 无证书（WS，默认）'
    $ipChoice=Ask '选择' '2'; if($ipChoice -eq '1'){$tlsChoice='2'}else{$tlsChoice='3'}
}

$mode=''; $publicPort=0
switch($tlsChoice){
    '1' {$mode='auto-tls'; $publicPort=443}
    '2' {
        $mode='manual-tls'; $cert=''; $key=''
        if($found -and (Confirm '使用自动发现的证书？' $true)){$cert=$found[0];$key=$found[1]}
        if(-not $cert){
            $cpath=Ask "输入证书文件或目录路径；回车重新扫描 $certDir"
            if(-not $cpath){$pair=Find-CertPair $certDir; if(-not $pair){throw "未在 $certDir 找到证书+私钥"}; $cert=$pair[0];$key=$pair[1]}
            elseif(Test-Path $cpath -PathType Container){$pair=Find-CertPair $cpath; if(-not $pair){throw '目录内未找到证书+私钥'}; $cert=$pair[0];$key=$pair[1]}
            else{if(-not(Test-Path $cpath -PathType Leaf)){throw "证书不存在：$cpath"}; $cert=$cpath; $key=Ask '请输入私钥路径'; if(-not(Test-Path $key -PathType Leaf)){throw "私钥不存在：$key"}}
        }
        Copy-IfDifferent $cert (Join-Path $certDir 'fullchain.pem') '证书'
        Copy-IfDifferent $key (Join-Path $certDir 'privkey.pem') '私钥'
        $publicPort=[int](Ask '设置公网 WSS 端口' '443'); if(-not(Valid-Port $publicPort)){throw '公网端口无效'}
        Warn "如果证书为自签或 SAN 不包含 $host，手机端可能拒绝 WSS。"
    }
    '3' {$mode='plain'; $publicPort=[int](Ask '设置公网 WS 端口' '80'); if(-not(Valid-Port $publicPort)){throw '公网端口无效'}}
    default {throw '无效选择'}
}
$relayInternalPort=[int](Ask 'Relay 容器内部端口（一般无需修改）' '9998'); if(-not(Valid-Port $relayInternalPort)){throw '内部端口无效'}
$relayName=Ask '中继显示名称' '北京官方中继'

$maxConnections=4000; $maxConnectionsPerIp=64; $maxClients=16; $maxBytes=262144; $maxMps=120; $idle=300000; $logLevel='info'
$adminUser='admin'; $adminInitialPassword='admin'; $adminSessionHours=8; $adminLoginMaxAttempts=5; $adminLoginWindowMs=600000; $adminLoginLockoutMs=900000; $adminApiMaxPerMinute=180; $adminGlobalLoginMaxPerMinute=60; $maxWsHandshakesPerMinute=240; $adminAllowInsecureHttp='false'
if(Confirm '是否修改高级防滥用参数？' $false){
    $maxConnections=[int](Ask '最大总 WebSocket 连接数' "$maxConnections")
    $maxConnectionsPerIp=[int](Ask '单公网 IP 最大并发连接数' "$maxConnectionsPerIp")
    $maxClients=[int](Ask '每个 Controller 最大手机数' "$maxClients")
    $maxBytes=[int](Ask '单条消息最大字节数' "$maxBytes")
    $maxMps=[int](Ask '单连接每秒最大消息数' "$maxMps")
    $idle=[int](Ask '无手机 Controller 回收时间(ms)' "$idle")
    $logLevel=Ask '日志级别(debug/info/warn/error)' $logLevel
    $adminLoginMaxAttempts=[int](Ask '管理后台：登录窗口内最大失败次数' "$adminLoginMaxAttempts")
    $adminLoginLockoutMs=[int](Ask '管理后台：触发后锁定时间(ms)' "$adminLoginLockoutMs")
    $adminApiMaxPerMinute=[int](Ask '管理后台：单 IP 每分钟 API 上限' "$adminApiMaxPerMinute")
    $adminGlobalLoginMaxPerMinute=[int](Ask '管理后台：全局每分钟登录请求上限' "$adminGlobalLoginMaxPerMinute")
    $maxWsHandshakesPerMinute=[int](Ask 'Relay：单 IP 每分钟 WebSocket 握手上限' "$maxWsHandshakesPerMinute")
}

if($mode -eq 'auto-tls'){$compose='compose.auto-tls.yaml';$scheme='wss';$clientPort=443;$healthScheme='https'}
elseif($mode -eq 'manual-tls'){$compose='compose.manual-tls.yaml';$scheme='wss';$clientPort=$publicPort;$healthScheme='https'}
else{$compose='compose.plain.yaml';$scheme='ws';$clientPort=$publicPort;$healthScheme='http'}
$uh=Url-Host $host
if(($scheme -eq 'wss' -and $clientPort -eq 443) -or ($scheme -eq 'ws' -and $clientPort -eq 80)){$relayUrl="$scheme`://$uh";$healthUrl="$healthScheme`://$uh/healthz";$adminUrl="$healthScheme`://$uh"}
else{$relayUrl="$scheme`://$uh`:$clientPort";$healthUrl="$healthScheme`://$uh`:$clientPort/healthz";$adminUrl="$healthScheme`://$uh`:$clientPort"}
if($mode -eq 'plain'){ Warn '当前为无 TLS 的 WS/HTTP 模式。为避免管理员密码明文传输，管理面板默认禁止登录。'; if(Confirm '是否仍允许 HTTP 登录管理面板？仅建议封闭测试网络使用' $false){$adminAllowInsecureHttp='true'} }

Backup-Config
Write-Caddy $mode $host $site $relayInternalPort
Write-Utf8NoBom '.env' @"
RELAY_INTERNAL_PORT=$relayInternalPort
PUBLIC_PORT=$publicPort
LOG_LEVEL=$logLevel
MAX_CONNECTIONS=$maxConnections
MAX_CONNECTIONS_PER_IP=$maxConnectionsPerIp
MAX_CLIENTS_PER_CONTROLLER=$maxClients
MAX_MESSAGE_BYTES=$maxBytes
MAX_MESSAGES_PER_SECOND=$maxMps
MAX_WS_HANDSHAKES_PER_MINUTE=$maxWsHandshakesPerMinute
IDLE_TIMEOUT=$idle
ADMIN_USER=$adminUser
ADMIN_INITIAL_PASSWORD=$adminInitialPassword
ADMIN_SESSION_HOURS=$adminSessionHours
ADMIN_LOGIN_MAX_ATTEMPTS=$adminLoginMaxAttempts
ADMIN_LOGIN_WINDOW_MS=$adminLoginWindowMs
ADMIN_LOGIN_LOCKOUT_MS=$adminLoginLockoutMs
ADMIN_API_MAX_PER_MINUTE=$adminApiMaxPerMinute
ADMIN_GLOBAL_LOGIN_MAX_PER_MINUTE=$adminGlobalLoginMaxPerMinute
ADMIN_ALLOW_INSECURE_HTTP=$adminAllowInsecureHttp
"@
Write-Utf8NoBom '.coyote-deploy.env' @"
COMPOSE_FILE=$compose
MODE=$mode
HOST=$host
HOST_KIND=$hostKind
SITE_DIR=$siteDir
PUBLIC_PORT=$publicPort
RELAY_INTERNAL_PORT=$relayInternalPort
RELAY_URL=$relayUrl
HEALTH_URL=$healthUrl
RELAY_NAME=$relayName
ADMIN_URL=$adminUrl
DETECTED_IPV4=$ipv4
DETECTED_IPV6=$ipv6
"@
Write-Utf8NoBom (Join-Path $siteDir 'site.env') @"
HOST=$host
HOST_KIND=$hostKind
MODE=$mode
PUBLIC_PORT=$publicPort
RELAY_INTERNAL_PORT=$relayInternalPort
RELAY_URL=$relayUrl
ADMIN_URL=$adminUrl
DETECTED_IPV4=$ipv4
DETECTED_IPV6=$ipv6
UPDATED_AT=$([DateTime]::UtcNow.ToString('o'))
"@
$relayJson=@{name=$relayName;url=$relayUrl}|ConvertTo-Json
Write-Utf8NoBom 'generated-client-config/official_relay.json' $relayJson

Info '验证 Docker Compose 配置...'; docker compose -f $compose config -q
Info '验证 Caddy 配置...'; docker run --rm -v "${PSScriptRoot}/Caddyfile.generated:/etc/caddy/Caddyfile:ro" -v "${PSScriptRoot}/sites:/srv/sites:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile | Out-Null
Stop-Existing
$checkPorts=if($mode -eq 'auto-tls'){@(80,443)}else{@($publicPort)}
foreach($p in $checkPorts){if(Test-PortBusy $p){Warn "TCP $p 已被其他程序监听"; if(-not(Confirm '仍继续部署？' $false)){throw "请释放端口 $p 后重试"}}}

if(Confirm '是否尝试自动添加 Windows 防火墙入站规则？云安全组仍需在云平台放行' $false){
    foreach($p in $checkPorts){
        try{if(-not(Get-NetFirewallRule -DisplayName "Coyote Relay TCP $p" -ErrorAction SilentlyContinue)){New-NetFirewallRule -DisplayName "Coyote Relay TCP $p" -Direction Inbound -Protocol TCP -LocalPort $p -Action Allow|Out-Null}}catch{Warn "无法自动设置防火墙（可能需要管理员 PowerShell）：$($_.Exception.Message)"}
    }
}

Info '构建并启动 Relay...'; docker compose -f $compose up -d --build
Info '容器状态：'; docker compose -f $compose ps
Info "健康检查：$healthUrl"
$healthOk=$false
for($i=0;$i -lt 45;$i++){
    try{
        if(Get-Command curl.exe -ErrorAction SilentlyContinue){
            $args=@('-fsS','--connect-timeout','3','--max-time','5'); if($mode -eq 'manual-tls'){$args+= '-k'}; $args+=$healthUrl
            $out=& curl.exe @args 2>$null; if($LASTEXITCODE -eq 0){Write-Host $out;$healthOk=$true;break}
        }else{ $r=Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5; if($r.StatusCode -eq 200){Write-Host $r.Content;$healthOk=$true;break} }
    }catch{}
    Start-Sleep -Seconds 2
}
if(-not $healthOk){Warn '自动健康检查未成功。自动证书首次签发可能需要更久；请执行 .\manage.ps1 logs / doctor。'}
Ok '部署完成'
Write-Host "模式:       $mode"
Write-Host "公开地址:   $host"
Write-Host "客户端地址: $relayUrl"
Write-Host "健康检查:   $healthUrl"
Write-Host "管理面板:   $adminUrl"
Write-Host "站点目录:   $siteDir"
Write-Host '客户端配置: generated-client-config/official_relay.json'
Write-Host ''
Write-Host '管理后台初始账号: admin'
Write-Host '管理后台初始密码: admin'
Warn '首次登录管理面板会强制修改初始密码。部署完成后请立即修改。'
if($mode -eq 'auto-tls'){Warn '自动证书要求 DNS 正确，且云安全组/系统防火墙放行 TCP 80/443。'}
if($mode -eq 'plain'){Warn '当前为无证书 WS；公网正式使用推荐域名 + WSS。'}
