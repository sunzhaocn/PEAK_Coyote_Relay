$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
if(-not(Test-Path '.coyote-deploy.env')){throw '未找到现有部署状态；首次部署请执行 deploy.ps1'}
Write-Host '[1/3] 备份现有配置 / 证书 / 安全数据' -ForegroundColor Cyan
& "$PSScriptRoot\manage.ps1" backup
Write-Host '[2/3] 重建镜像并强制刷新容器' -ForegroundColor Cyan
& "$PSScriptRoot\manage.ps1" reload
Write-Host '[3/3] 状态检查' -ForegroundColor Cyan
& "$PSScriptRoot\manage.ps1" status
Write-Host 'V2.6 升级完成。运行 .\manage.ps1 doctor 可做完整诊断。' -ForegroundColor Green
