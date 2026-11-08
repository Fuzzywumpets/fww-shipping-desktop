<#
.SYNOPSIS
  FWW Shipping machine-wide updater. Runs as SYSTEM from the "<productName> Updater" scheduled task
  that register-task.ps1 creates at install time.

.DESCRIPTION
  WHY: the app is a per-machine NSIS install (Program Files, every Windows account; README
  "Machine-wide install"). electron-updater can only apply such an update through elevate.exe, which
  raises UAC, so on a staff (standard) account every update needed Alex's admin password. This task
  already runs as SYSTEM, so it can install the update with no prompt.

  Steps: read the feed (latest.yml), compare with the installed exe version, download the installer
  into an admin-only folder, verify its sha512 against the feed, wait for every copy of the app (any
  session) to be closed, then run the installer silently with --updated.

  INVARIANT: never install while the app is running in ANY session. For per-all-users builds,
  electron-builder's silent CHECK_APP_RUNNING runs `taskkill /f /im <exe>` across all users
  (app-builder-lib templates/nsis/include/allowOnlyOneInstallerInstance.nsh), so installing while a
  packer has the app open would close it mid-label.
  INVARIANT: the download folder must stay writable by SYSTEM and Administrators only. Otherwise a
  staff account could swap the verified installer before SYSTEM runs it (privilege escalation).

  DEPENDS: register-task.ps1 builds this script's command line (-AppExe, optional -FeedUrl) and sets
  the task's working directory to the ProgramData folder; keep the parameter names in step.
  DEPENDS: resources\app-update.yml (written by electron-builder from package.json build.publish)
  supplies owner/repo when -FeedUrl is not given.

.PARAMETER DryRun
  Do everything except run the installer (tests).
#>
[CmdletBinding()]
param(
  [string]$InstallDir = '',   # default set below: $PSScriptRoot is empty in param() defaults on PowerShell 5.1
  [string]$AppExe = 'FWW Shipping.exe',
  [string]$FeedUrl = '',
  [string]$DataDir = (Join-Path $env:ProgramData 'FWW Shipping'),
  [string]$InstalledVersion = '',
  [int]$WaitForExitSec = 90,
  [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
# <InstallDir>\resources\updater\fww-update.ps1
if (-not $InstallDir) { $InstallDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot) }

$SID_SYSTEM = '*S-1-5-18'
$SID_ADMINS = '*S-1-5-32-544'
$SID_USERS  = '*S-1-5-32-545'

function Write-Log([string]$msg) {
  $line = '{0} [{1}] {2}' -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'), $PID, $msg
  try {
    $log = Join-Path $DataDir 'updater.log'
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 1MB) { Move-Item -Force $log "$log.1" }
    Add-Content -Path $log -Value $line -Encoding UTF8
  } catch { }
  Write-Host $line   # not Write-Output: Invoke-Update's pipeline output is its exit code
}

# Owner Administrators, inheritance off, SYSTEM + Administrators full, Users read-only. Applied on
# every run, so a folder a staff account pre-created (ProgramData lets Users create folders) is taken
# back before anything is downloaded into it.
# SYNC: protect-dir - register-task.ps1 applies the same three icacls steps to the same folder.
# The explicit grant goes on the folder only: with /T, icacls strips a FILE's inherited ACEs but
# cannot put (OI)(CI) ACEs on it, leaving an empty DACL that even SYSTEM cannot open. Children are
# reset to inherit from the folder instead, which also drops any write ACE a user planted on a file.
function Protect-Dir([string]$dir) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  & icacls.exe $dir /setowner $SID_ADMINS /T /C /Q | Out-Null
  & icacls.exe $dir /inheritance:r /grant:r "${SID_SYSTEM}:(OI)(CI)F" "${SID_ADMINS}:(OI)(CI)F" "${SID_USERS}:(OI)(CI)RX" /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls failed on $dir (exit $LASTEXITCODE)" }
  if (Get-ChildItem -Force -Path $dir) {
    & icacls.exe (Join-Path $dir '*') /reset /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls /reset failed under $dir (exit $LASTEXITCODE)" }
  }
  # Only the bits that let a principal change contents, delete, or re-ACL (FullControl/Modify as
  # flags include the read bits too). 0x50000000 = GENERIC_ALL | GENERIC_WRITE on raw ACEs.
  $writeRights = [int]([System.Security.AccessControl.FileSystemRights]'WriteData, AppendData, WriteExtendedAttributes, WriteAttributes, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership') -bor 0x50000000
  foreach ($ace in (Get-Acl $dir).Access) {
    $sid = try { $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { '' }
    if ($sid -in @('S-1-5-18', 'S-1-5-32-544')) { continue }
    if ($ace.AccessControlType -eq 'Allow' -and ([int]$ace.FileSystemRights -band $writeRights)) {
      throw "unsafe ACL on ${dir}: $($ace.IdentityReference) has $($ace.FileSystemRights)"
    }
  }
}

# Minimal reader for electron-builder's latest.yml (top-level `version`, `path`, `sha512`).
function Read-LatestYml([string]$text) {
  $r = @{}
  foreach ($line in ($text -split "`r?`n")) {
    if ($line -match '^(version|path|sha512):\s*(.+?)\s*$') { $r[$Matches[1]] = $Matches[2].Trim("'`"") }
  }
  if (-not $r.ContainsKey('version') -or $r.version -notmatch '^\d+\.\d+\.\d+$') { throw 'feed has no valid version' }
  if (-not $r.ContainsKey('path') -or $r.path -notmatch '^[A-Za-z0-9._-]+\.exe$') { throw 'feed has no valid installer path' }
  if (-not $r.ContainsKey('sha512') -or $r.sha512 -notmatch '^[A-Za-z0-9+/]{86}==$') { throw 'feed has no valid sha512' }
  return $r
}

# owner/repo from the installed resources\app-update.yml (provider: github).
function Get-DefaultFeedUrl([string]$installDir) {
  $yml = Join-Path $installDir 'resources\app-update.yml'
  $text = Get-Content -Raw -Path $yml
  $owner = if ($text -match '(?m)^owner:\s*(\S+)') { $Matches[1] } else { '' }
  $repo  = if ($text -match '(?m)^repo:\s*(\S+)')  { $Matches[1] } else { '' }
  if ($owner -notmatch '^[A-Za-z0-9_.-]+$' -or $repo -notmatch '^[A-Za-z0-9_.-]+$') { throw "no owner/repo in $yml" }
  return "https://github.com/$owner/$repo/releases/latest/download/latest.yml"
}

function Get-Sha512Base64([string]$file) {
  $hex = (Get-FileHash -Algorithm SHA512 -Path $file).Hash
  $bytes = New-Object byte[] ($hex.Length / 2)
  for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
  return [Convert]::ToBase64String($bytes)
}

function Get-InstalledVersion([string]$exe) {
  if ($InstalledVersion) { return [version]$InstalledVersion }
  $v = (Get-Item $exe).VersionInfo.FileVersion
  if ($v -notmatch '^(\d+)\.(\d+)\.(\d+)') { throw "cannot read the version of $exe" }
  return [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3])
}

# Every copy of the app in every session (SYSTEM sees all sessions).
function Get-AppProcesses {
  $name = [System.IO.Path]::GetFileNameWithoutExtension($AppExe)
  return @(Get-Process -Name $name -ErrorAction SilentlyContinue)
}

function Invoke-Update {
  Protect-Dir $DataDir
  Write-Log "run: install dir $InstallDir, app $AppExe"
  Set-Location $DataDir   # never hold a handle on $InstallDir: the update deletes and rewrites it
  $work = Join-Path $DataDir 'updates'
  Protect-Dir $work

  $exe = Join-Path $InstallDir $AppExe
  $installed = Get-InstalledVersion $exe
  $feedUrl = if ($FeedUrl) { $FeedUrl } else { Get-DefaultFeedUrl $InstallDir }

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $wc = New-Object System.Net.WebClient
  $feed = Read-LatestYml ($wc.DownloadString($feedUrl))
  $available = [version]$feed.version
  if ($available -le $installed) { Write-Log "up to date: installed $installed, feed $available"; return 0 }

  # The installer sits next to latest.yml (GitHub: releases/latest/download/<file>).
  $installerUrl = $feedUrl.Substring(0, $feedUrl.LastIndexOf('/') + 1) + $feed.path
  $installer = Join-Path $work $feed.path
  Write-Log "update $installed -> ${available}: downloading $installerUrl"
  $wc.DownloadFile($installerUrl, $installer)
  $actual = Get-Sha512Base64 $installer
  if ($actual -ne $feed.sha512) {
    Remove-Item -Force $installer
    Write-Log "ABORT: sha512 mismatch for $($feed.path) (feed $($feed.sha512), file $actual)"
    return 3
  }

  $deadline = (Get-Date).AddSeconds($WaitForExitSec)
  while (@(Get-AppProcesses).Count -gt 0) {   # @(): an empty result unrolls to $null under StrictMode
    if ((Get-Date) -ge $deadline) {
      $sessions = (Get-AppProcesses | ForEach-Object { $_.SessionId } | Sort-Object -Unique) -join ','
      Write-Log "deferred: $AppExe is still running (session $sessions); will retry on the next trigger"
      return 0
    }
    Start-Sleep -Seconds 5
  }

  if ($DryRun) { Write-Log "dry run: would run $installer /S --updated"; return 0 }

  # Re-check the hash right before running (the folder is admin-only; this is belt and braces).
  if ((Get-Sha512Base64 $installer) -ne $feed.sha512) { Write-Log 'ABORT: installer changed after verification'; return 3 }
  Write-Log "installing $available"
  $p = Start-Process -FilePath $installer -ArgumentList '/S', '--updated' -Wait -PassThru
  $after = Get-InstalledVersion $exe
  Remove-Item -Force $installer -ErrorAction SilentlyContinue
  if ($p.ExitCode -ne 0 -or $after -lt $available) {
    Write-Log "FAILED: installer exit $($p.ExitCode), installed version now $after"
    return 4
  }
  Write-Log "installed $after"
  return 0
}

if ($MyInvocation.InvocationName -ne '.') {
  $mutex = New-Object System.Threading.Mutex($false, 'Global\FWWShippingSystemUpdater')
  if (-not $mutex.WaitOne(0)) { Write-Log 'another updater run is active; exiting'; exit 0 }
  try { $code = Invoke-Update } catch { Write-Log "ERROR: $($_.Exception.Message)"; $code = 1 } finally { $mutex.ReleaseMutex() }
  exit $code
}
