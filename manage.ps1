param([string]$Action='menu')
$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot

function Read-State {
  if(-not(Test-Path '.coyote-deploy.env')){throw '尚未部署；请先运行 deploy.cmd/deploy.ps1'}
  $script:state=@{}
  Get-Content '.coyote-deploy.env' | ForEach-Object { if($_ -match '^([^=]+)=(.*)$'){$script:state[$matches[1]]=$matches[2]} }
  $script:compose=$script:state['COMPOSE_FILE']; if(-not $script:compose -or -not(Test-Path $script:compose)){throw '部署状态中的 Compose 文件无效'}
}
function Backup-Now{
  $ts=Get-Date -Format 'yyyyMMdd-HHmmss'; $d=Join-Path 'backups' "manual-$ts"; New-Item -ItemType Directory -Force $d|Out-Null
  foreach($f in '.coyote-deploy.env','Caddyfile.generated','.env'){if(Test-Path $f){Copy-Item $f $d -Force}}
  if(Test-Path sites){Copy-Item sites (Join-Path $d 'sites') -Recurse -Force}
  try{docker compose -f $compose exec -T relay sh -lc 'cat /data/security.json 2>/dev/null || true' | Out-File (Join-Path $d 'security.json') -Encoding utf8}catch{}
  Write-Host "备份完成: $d"
}
function Doctor{
  Write-Host '=== Coyote Relay Doctor ===' -ForegroundColor Cyan
  Write-Host "模式: $($state['MODE'])"; Write-Host "地址: $($state['RELAY_URL'])"; Write-Host "Health: $($state['HEALTH_URL'])"; Write-Host "Admin: $($state['ADMIN_URL'])"
  docker compose -f $compose ps
  Write-Host "`n[Public health]"
  try{if(Get-Command curl.exe -ErrorAction SilentlyContinue){$args=@('-v','--connect-timeout','5','--max-time','10');if($state['MODE'] -eq 'manual-tls'){$args+='-k'};$args+=$state['HEALTH_URL']; & curl.exe @args}else{(Invoke-WebRequest -Uri $state['HEALTH_URL'] -UseBasicParsing -TimeoutSec 10).Content}}catch{Write-Warning $_.Exception.Message}
  Write-Host "`n[Recent relay logs]"; docker compose -f $compose logs relay --tail=60
  Write-Host "`n[Recent caddy logs]"; docker compose -f $compose logs caddy --tail=60
}
function Admin-Reset{
  $v=Read-Host '将管理员恢复为 admin/admin（黑名单保留）。输入 YES 确认'; if($v -ne 'YES'){Write-Host '已取消';return}
  docker compose -f $compose stop relay; docker compose -f $compose run --rm relay bun run /app/v4-server.ts --reset-admin; docker compose -f $compose up -d relay
  Write-Host "管理员已重置。管理地址: $($state['ADMIN_URL'])"
}
function Invoke-Action([string]$A){
  if($A -eq 'reconfigure'){& "$PSScriptRoot\deploy.ps1"; return}
  Read-State
  switch($A){
    'status' {docker compose -f $compose ps}
    'logs' {docker compose -f $compose logs -f --tail=200}
    'relay-logs' {docker compose -f $compose logs -f --tail=200 relay}
    'caddy-logs' {docker compose -f $compose logs -f --tail=200 caddy}
    'start' {docker compose -f $compose up -d}
    'stop' {docker compose -f $compose down}
    'restart' {docker compose -f $compose restart}
    'update' {docker compose -f $compose up -d --build}
    'reload' {docker compose -f $compose up -d --build --force-recreate}
    'doctor' {Doctor}
    'config' {Get-Content '.coyote-deploy.env';Write-Host "`n=== .env ===";Get-Content '.env';Write-Host "`n=== Caddy ===";Get-Content 'Caddyfile.generated'}
    'admin' {Write-Host "管理面板: $($state['ADMIN_URL'])"}
    'admin-reset' {Admin-Reset}
    'security-export' {docker compose -f $compose exec -T relay sh -lc 'cat /data/security.json' | Out-File 'security-export.json' -Encoding utf8; Write-Host '已导出 security-export.json'}
    'certs' {$d=Join-Path $state['SITE_DIR'] 'certs';if(Test-Path $d){Get-ChildItem $d|Format-Table Name,Length,LastWriteTime}}
    'backup' {Backup-Now}
    'purge' {$v=Read-Host '这会删除容器、Caddy 状态卷和 Relay 安全数据卷。输入 YES 确认';if($v -eq 'YES'){docker compose -f $compose down -v}else{Write-Host '已取消'}}
    default {throw "未知操作: $A"}
  }
}
function Menu{
  while($true){
    Write-Host @'
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
'@
    $n=Read-Host '请选择'
    $map=@{'1'='status';'2'='logs';'3'='relay-logs';'4'='caddy-logs';'5'='restart';'6'='reload';'7'='doctor';'8'='config';'9'='admin';'10'='admin-reset';'11'='security-export';'12'='certs';'13'='backup';'14'='reconfigure';'15'='stop';'16'='start';'17'='purge'}
    if($n -eq '0'){return}; if($map.ContainsKey($n)){try{Invoke-Action $map[$n]}catch{Write-Warning $_.Exception.Message}}else{Write-Warning '无效选择'}
    Read-Host '按 Enter 返回菜单' | Out-Null
  }
}
if($Action -eq 'menu'){Menu}else{Invoke-Action $Action}
