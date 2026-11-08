<#
.SYNOPSIS
  Install-time (elevated) setup of the SYSTEM update task. Called by build/installer.nsh
  customInstall on every install and every update.

.DESCRIPTION
  1. Creates C:\ProgramData\FWW Shipping (admin-only write) for the updater's downloads and log.
  2. Registers (or replaces) the scheduled task <TaskName>: runs fww-update.ps1 as SYSTEM at boot,
     at any user's logon and hourly. Users get read+run on the task only, so the app can trigger it
     with `schtasks /Run` when someone quits; they cannot change what it runs.
  3. Writes resources\updater\system-updates.json. The app treats that file as "updates are
     machine-managed" and stops using electron-updater's elevating quitAndInstall.
  Step 3 runs only after 1 and 2 succeed, so a failed registration leaves the app on the old
  (UAC) update path rather than on no update path at all.

  SYNC: system-updates-marker - updater-mode.js readSystemUpdater() parses the marker; keep the
  file name and the {taskName, version} shape in step (test/system-updater.test.js checks both).
  DEPENDS: fww-update.ps1 parameters (-InstallDir, -AppExe, -FeedUrl) and its default ProgramData folder.
  DEPENDS: build/installer.nsh passes -TaskName "${PRODUCT_NAME} Updater"; customUnInstall deletes
  that same name.

.PARAMETER FeedUrl
  Tests only: bake a non-GitHub feed into the task. Production passes nothing, so the updater reads
  owner/repo from resources\app-update.yml.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$TaskName,
  [Parameter(Mandatory = $true)][string]$AppExe,
  [string]$FeedUrl = ''
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# A trailing backslash would escape the closing quote of -InstallDir "...\" on the task command line.
$InstallDir = $InstallDir.TrimEnd('\')
if ($TaskName -notmatch '^[A-Za-z0-9 ._-]{1,64}$') { throw "bad task name: $TaskName" }
if ($AppExe -notmatch '^[A-Za-z0-9 ._-]{1,64}\.exe$') { throw "bad exe name: $AppExe" }

$script = Join-Path $InstallDir 'resources\updater\fww-update.ps1'
if (-not (Test-Path $script)) { throw "missing $script" }
$marker = Join-Path $InstallDir 'resources\updater\system-updates.json'
Remove-Item -Force $marker -ErrorAction SilentlyContinue

# 1. Data folder: owner Administrators, no inheritance, SYSTEM/Administrators full, Users read.
# SYNC: protect-dir - same three icacls steps as fww-update.ps1 Protect-Dir (grant on the folder
# only, never with /T: that leaves files with an empty DACL; children are reset to inherit).
$dataDir = Join-Path $env:ProgramData 'FWW Shipping'
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
& icacls.exe $dataDir /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
& icacls.exe $dataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /C /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "icacls failed on $dataDir (exit $LASTEXITCODE)" }
if (Get-ChildItem -Force -Path $dataDir) {
  & icacls.exe (Join-Path $dataDir '*') /reset /T /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls /reset failed under $dataDir (exit $LASTEXITCODE)" }
}

# 2. The task.
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arg = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -InstallDir `"$InstallDir`" -AppExe `"$AppExe`""
if ($FeedUrl) { $arg += " -FeedUrl `"$FeedUrl`"" }
$action = New-ScheduledTaskAction -Execute $ps -Argument $arg -WorkingDirectory $dataDir

$atBoot = New-ScheduledTaskTrigger -AtStartup
$atBoot.Delay = 'PT2M'
$atLogon = New-ScheduledTaskTrigger -AtLogOn
$hourly = New-ScheduledTaskTrigger -Daily -At '03:00'
$hourly.Repetition = (New-ScheduledTaskTrigger -Once -At '03:00' -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Hours 23)).Repetition

$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -Action $action -Trigger @($atBoot, $atLogon, $hourly) `
  -Principal $principal -Settings $settings -Force | Out-Null

# Administrators + SYSTEM full; Builtin Users read + execute (start it), no write.
$svc = New-Object -ComObject 'Schedule.Service'
$svc.Connect()
$svc.GetFolder('\').GetTask($TaskName).SetSecurityDescriptor('D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;GRGX;;;BU)', 0)

# 3. Marker for the app (written last).
$version = (Get-Item (Join-Path $InstallDir $AppExe)).VersionInfo.FileVersion
@{ taskName = $TaskName; version = $version } | ConvertTo-Json -Compress | Set-Content -Path $marker -Encoding ASCII
Write-Host "registered task '$TaskName' for $AppExe $version"
