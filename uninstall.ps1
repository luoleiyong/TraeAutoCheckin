param([string]$TaskName = "TraeAutoCheckin")
$ErrorActionPreference = "Continue"
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "已移除计划任务: $TaskName" -ForegroundColor Green
