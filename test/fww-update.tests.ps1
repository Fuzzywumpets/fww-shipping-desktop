<#
  Tests for updater/fww-update.ps1 (Windows PowerShell 5.1, no Pester). Run elevated on Windows:
    powershell -NoProfile -ExecutionPolicy Bypass -File test\fww-update.tests.ps1
  Nothing is installed: end-to-end runs use a local file:// feed and -DryRun, in a temp folder.
  Exit code = number of failed tests.
#>
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot '..\updater\fww-update.ps1' | Resolve-Path
$tmp = Join-Path $env:TEMP ("fww-update-tests-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
$failed = 0
function Check([string]$name, [scriptblock]$body) {
  try { & $body; Write-Host "PASS $name" } catch { $script:failed++; Write-Host "FAIL $name : $($_.Exception.Message)" }
}
function Assert($cond, [string]$msg) { if (-not $cond) { throw $msg } }

# Dot-source for the functions (the script only runs Invoke-Update when not dot-sourced).
. $script -DataDir (Join-Path $tmp 'dot')

$realYml = @"
version: 1.0.23
files:
  - url: FWW-Shipping-Setup-1.0.23.exe
    sha512: o6dmWmSYr0ycpsNpmPhlohVosMIi+2Y2aegZSnewmdNtFE6c7MbQgnOaXWkYoeF2Onj0acjNstPk6YRYnSCS9w==
    size: 87166111
    isAdminRightsRequired: true
path: FWW-Shipping-Setup-1.0.23.exe
sha512: o6dmWmSYr0ycpsNpmPhlohVosMIi+2Y2aegZSnewmdNtFE6c7MbQgnOaXWkYoeF2Onj0acjNstPk6YRYnSCS9w==
releaseDate: '2026-10-13T16:33:12.828Z'
"@

Check 'Read-LatestYml parses the published v1.0.23 feed' {
  $r = Read-LatestYml $realYml
  Assert ($r.version -eq '1.0.23') "version $($r.version)"
  Assert ($r.path -eq 'FWW-Shipping-Setup-1.0.23.exe') "path $($r.path)"
  Assert ($r.sha512.StartsWith('o6dmWmSY')) 'sha512'
}

Check 'Read-LatestYml rejects a path that leaves the download folder, a bad version or sha' {
  foreach ($bad in @(
      ($realYml -replace 'path: FWW-Shipping-Setup-1.0.23.exe', 'path: ..\evil.exe'),
      ($realYml -replace 'version: 1.0.23', 'version: latest'),
      ($realYml -replace '(?m)^sha512: .*$', 'sha512: abc'))) {
    $threw = $false; try { Read-LatestYml $bad | Out-Null } catch { $threw = $true }
    Assert $threw 'expected a throw'
  }
}

Check 'Get-Sha512Base64 matches the latest.yml encoding (SHA-512 of "abc")' {
  $f = Join-Path $tmp 'abc.txt'; [IO.File]::WriteAllBytes($f, [Text.Encoding]::ASCII.GetBytes('abc'))
  $h = Get-Sha512Base64 $f
  Assert ($h -eq '3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==') $h
}

Check 'Get-DefaultFeedUrl reads owner/repo from resources\app-update.yml' {
  $inst = Join-Path $tmp 'inst-feed'; New-Item -ItemType Directory -Path "$inst\resources" -Force | Out-Null
  "owner: Fuzzywumpets`nrepo: fww-shipping-desktop`nprovider: github`n" | Set-Content "$inst\resources\app-update.yml"
  $u = Get-DefaultFeedUrl $inst
  Assert ($u -eq 'https://github.com/Fuzzywumpets/fww-shipping-desktop/releases/latest/download/latest.yml') $u
}

Check 'Protect-Dir takes back a folder a standard user pre-created with write access' {
  $d = Join-Path $tmp 'protect'; New-Item -ItemType Directory -Path $d | Out-Null
  & icacls.exe $d /grant '*S-1-5-32-545:(OI)(CI)F' /Q | Out-Null
  Protect-Dir $d
  $users = (Get-Acl $d).Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq 'S-1-5-32-545' }
  Assert (@($users).Count -ge 1) 'Users should keep read access'
  $w = [int]([Security.AccessControl.FileSystemRights]'WriteData, AppendData, Delete, DeleteSubdirectoriesAndFiles, ChangePermissions, TakeOwnership') -bor 0x50000000
  foreach ($a in $users) { Assert (-not ([int]$a.FileSystemRights -band $w)) "Users still has $($a.FileSystemRights)" }
  $owner = (Get-Acl $d).GetOwner([Security.Principal.SecurityIdentifier]).Value
  Assert ($owner -eq 'S-1-5-32-544') "owner $owner"
}

Check 'Protect-Dir keeps files inside readable by SYSTEM/Admins and drops a planted Users write ACE' {
  $d = Join-Path $tmp 'protect-files'; New-Item -ItemType Directory -Path "$d\sub" -Force | Out-Null
  'x' | Set-Content "$d\updater.log"; 'y' | Set-Content "$d\sub\setup.exe"
  & icacls.exe "$d\sub\setup.exe" /grant '*S-1-5-32-545:F' /Q | Out-Null
  Protect-Dir $d; Protect-Dir $d   # twice: every run re-applies it
  Assert ((Get-Content "$d\updater.log") -eq 'x') 'log must stay readable'
  Assert ((Get-Content "$d\sub\setup.exe") -eq 'y') 'installer must stay readable'
  $w = [int]([Security.AccessControl.FileSystemRights]'WriteData, AppendData, Delete, ChangePermissions, TakeOwnership') -bor 0x50000000
  foreach ($f in @("$d\updater.log", "$d\sub\setup.exe")) {
    $acl = Get-Acl $f
    Assert (@($acl.Access).Count -ge 2) "$f has an empty DACL"
    foreach ($a in $acl.Access) {
      $sid = $a.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
      if ($sid -notin @('S-1-5-18', 'S-1-5-32-544')) { Assert (-not ([int]$a.FileSystemRights -band $w)) "$f : $sid has $($a.FileSystemRights)" }
    }
  }
}

# End-to-end runs of the real script in a child process (exit code + log), with a local feed.
$feedDir = Join-Path $tmp 'feed'; New-Item -ItemType Directory -Path $feedDir | Out-Null
$fake = Join-Path $feedDir 'FWW-Shipping-Setup-1.0.5.exe'; [IO.File]::WriteAllBytes($fake, [byte[]](1..200))
$sha = Get-Sha512Base64 $fake
"version: 1.0.5`npath: FWW-Shipping-Setup-1.0.5.exe`nsha512: $sha`n" | Set-Content (Join-Path $feedDir 'latest.yml')
"version: 1.0.5`npath: FWW-Shipping-Setup-1.0.5.exe`nsha512: $($sha.Substring(0,10))AAAAAAAAAA$($sha.Substring(20))`n" | Set-Content (Join-Path $feedDir 'bad.yml')
$feedUrl = ([Uri](Join-Path $feedDir 'latest.yml')).AbsoluteUri
$badUrl = ([Uri](Join-Path $feedDir 'bad.yml')).AbsoluteUri

function Run-Updater([string]$name, [string[]]$extra) {
  $data = Join-Path $tmp "data-$name"
  $argv = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script, '-InstallDir', $tmp, '-DataDir', $data, '-DryRun') + $extra
  $out = & powershell.exe @argv 2>&1 | Out-String
  return @{ code = $LASTEXITCODE; out = $out; log = (Get-Content -Raw (Join-Path $data 'updater.log') -ErrorAction SilentlyContinue); data = $data }
}

Check 'newer feed: downloads, verifies sha512, would install (dry run)' {
  $r = Run-Updater 'newer' @('-AppExe', 'no-such-app.exe', '-FeedUrl', $feedUrl, '-InstalledVersion', '1.0.0')
  Assert ($r.code -eq 0) "exit $($r.code): $($r.out)"
  Assert ($r.log -match 'update 1\.0\.0 -> 1\.0\.5') $r.log
  Assert ($r.log -match 'dry run: would run') $r.log
  Assert (Test-Path (Join-Path $r.data 'updates\FWW-Shipping-Setup-1.0.5.exe')) 'installer downloaded into the protected folder'
}

Check 'same version: up to date, nothing downloaded' {
  $r = Run-Updater 'same' @('-AppExe', 'no-such-app.exe', '-FeedUrl', $feedUrl, '-InstalledVersion', '1.0.5')
  Assert ($r.code -eq 0) "exit $($r.code)"
  Assert ($r.log -match 'up to date') $r.log
  Assert (-not (Test-Path (Join-Path $r.data 'updates\FWW-Shipping-Setup-1.0.5.exe'))) 'nothing downloaded'
}

Check 'sha512 mismatch: exit 3, file removed, never installs' {
  $r = Run-Updater 'badsha' @('-AppExe', 'no-such-app.exe', '-FeedUrl', $badUrl, '-InstalledVersion', '1.0.0')
  Assert ($r.code -eq 3) "exit $($r.code): $($r.log)"
  Assert ($r.log -match 'sha512 mismatch') $r.log
  Assert (-not (Test-Path (Join-Path $r.data 'updates\FWW-Shipping-Setup-1.0.5.exe'))) 'file removed'
}

Check 'app still running in some session: deferred, exit 0, no install' {
  # powershell.exe is running (this test), so it stands in for an open FWW Shipping.
  $r = Run-Updater 'running' @('-AppExe', 'powershell.exe', '-FeedUrl', $feedUrl, '-InstalledVersion', '1.0.0', '-WaitForExitSec', '1')
  Assert ($r.code -eq 0) "exit $($r.code)"
  Assert ($r.log -match 'deferred: powershell\.exe is still running') $r.log
  Assert ($r.log -notmatch 'dry run: would run') 'must not reach the install step'
}

Check 'sha512 that differs only in letter case is rejected (Base64 is case-sensitive)' {
  $flip = if ($sha[0] -cmatch '[a-z]') { $sha.Substring(0,1).ToUpper() } elseif ($sha[0] -cmatch '[A-Z]') { $sha.Substring(0,1).ToLower() } else { $null }
  $i = 0; while (-not $flip) { $i++; $c = $sha[$i]; if ($c -cmatch '[a-z]') { $flip = "$c".ToUpper() } elseif ($c -cmatch '[A-Z]') { $flip = "$c".ToLower() } }
  $caseSha = $sha.Substring(0, $i) + $flip + $sha.Substring($i + 1)
  Assert ($caseSha -ne $sha -and $caseSha -ieq $sha) 'test setup: same letters, different case'
  "version: 1.0.5`npath: FWW-Shipping-Setup-1.0.5.exe`nsha512: $caseSha`n" | Set-Content (Join-Path $feedDir 'case.yml')
  $r = Run-Updater 'case' @('-AppExe', 'no-such-app.exe', '-FeedUrl', ([Uri](Join-Path $feedDir 'case.yml')).AbsoluteUri, '-InstalledVersion', '1.0.0')
  Assert ($r.code -eq 3) "exit $($r.code): $($r.log)"
  Assert ($r.log -match 'sha512 mismatch') $r.log
}

Check 'missing app exe (interrupted install) counts as 0.0.0 so the next run repairs it' {
  $r = Run-Updater 'heal' @('-AppExe', 'no-such-app.exe', '-FeedUrl', $feedUrl)
  Assert ($r.code -eq 0) "exit $($r.code): $($r.log)"
  Assert ($r.log -match 'treating the installed version as 0\.0\.0') $r.log
  Assert ($r.log -match 'update 0\.0\.0 -> 1\.0\.5') $r.log
}

Check 'installed layout without -InstallDir: install dir comes from the script location (PS 5.1 param-default bug)' {
  $lay = Join-Path $tmp 'layout'; $upd = Join-Path $lay 'resources\updater'; New-Item -ItemType Directory -Path $upd -Force | Out-Null
  Copy-Item $script (Join-Path $upd 'fww-update.ps1')
  $data = Join-Path $tmp 'data-layout'
  $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $upd 'fww-update.ps1') -AppExe 'no-such-app.exe' -FeedUrl $feedUrl -InstalledVersion '1.0.5' -DataDir $data 2>&1 | Out-String
  Assert ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE : $out"
  $log = Get-Content -Raw (Join-Path $data 'updater.log')
  Assert ($log -match [regex]::Escape("install dir $lay,")) $log
}

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
Write-Host "failed: $failed"
exit $failed
