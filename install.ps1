<#
  install.ps1 — 注册"Trae CN 自动签到"计划任务
  用法:
    powershell -ExecutionPolicy Bypass -File .\install.ps1
    powershell -ExecutionPolicy Bypass -File .\install.ps1 -At 09:05 -TaskName TraeAutoCheckin
#>
param(
  [string]$At = "09:05",
  [string]$TaskName = "TraeAutoCheckin",
  [switch]$AlsoAtLogon
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs  = Join-Path $root "run-silent.vbs"

if (-not (Test-Path $vbs)) { throw "找不到 $vbs" }

# 先跑一次，确认环境可用
Write-Host "== 试运行一次 ==" -ForegroundColor Cyan
& cmd /c "`"$root\run.bat`" status"

$action   = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`"" -WorkingDirectory $root
$trigger  = New-ScheduledTaskTrigger -Daily -At $At
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
             -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description "Trae CN 每日自动签到领取积分" -Force | Out-Null

if ($AlsoAtLogon) {
  $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $task = Get-ScheduledTask -TaskName $TaskName
  $task.Triggers += $logonTrigger
  Set-ScheduledTask -TaskName $TaskName -Trigger $task.Triggers | Out-Null
}

Write-Host "已注册计划任务: $TaskName (每日 $At 执行)" -ForegroundColor Green
Write-Host "查看: schtasks /Query /TN $TaskName /V /FO LIST"
Write-Host "立即执行: schtasks /Run /TN $TaskName"
Write-Host "卸载: powershell -ExecutionPolicy Bypass -File .\uninstall.ps1"
