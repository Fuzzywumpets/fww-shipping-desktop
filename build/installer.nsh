; FWW Shipping NSIS hooks (package.json build.nsis.include).
;
; customInstall: registers the "<productName> Updater" SYSTEM task (updater/register-task.ps1) on
; every install AND every update, so a later build can change the task. A failure is logged and does
; NOT fail the install: register-task.ps1 then writes no marker, and the app falls back to
; electron-updater's own (UAC) path.
; customUnInstall: deletes the task on a real uninstall only. electron-builder runs the OLD
; uninstaller with --updated during every update; deleting the task there would remove it on each
; update.
;
; SYNC: updater-task-name - the task name is "${PRODUCT_NAME} Updater" in both macros below;
; register-task.ps1 writes it into resources\updater\system-updates.json, which main.js reads.
; DEPENDS: package.json build.extraResources copies updater/*.ps1 to $INSTDIR\resources\updater.
; DEPENDS: nsis.perMachine:true (README "Machine-wide install"); a per-user install cannot create a
; SYSTEM task, and Program Files is what keeps the task's script admin-only.

!macro fwwPowerShell _OUT
  ; The installer stub is 32-bit: use Sysnative to reach the 64-bit PowerShell (ScheduledTasks module).
  ${If} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    StrCpy ${_OUT} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${Else}
    StrCpy ${_OUT} "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
!macroend

; customCheckAppRunning: electron-builder's default (_CHECK_APP_RUNNING) force-closes every running
; copy of the app in every account during a silent per-machine install. When fww-update.ps1 runs the
; installer it passes --fww-system-update, and then a running copy makes the installer quit with
; exit code 75 (nothing touched) so the updater defers instead of closing a packer's app mid-label.
; Every other run (manual install, the old uninstaller during an update) keeps the default.
; SYNC: system-update-defer - fww-update.ps1 passes --fww-system-update and treats exit 75 as "deferred".
!macro customCheckAppRunning
  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "--fww-system-update" $R1
  ${if} ${Errors}
    !insertmacro _CHECK_APP_RUNNING
  ${else}
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      DetailPrint `"${PRODUCT_NAME}" is running: system update deferred`
      SetErrorLevel 75
      Quit
    ${endIf}
  ${endIf}
!macroend

!macro customInstall
  !insertmacro fwwPowerShell $R8
  DetailPrint "Registering ${PRODUCT_NAME} Updater task"
  nsExec::ExecToLog '"$R8" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\updater\register-task.ps1" -InstallDir "$INSTDIR" -TaskName "${PRODUCT_NAME} Updater" -AppExe "${APP_EXECUTABLE_FILENAME}"'
  Pop $R9
  DetailPrint "register-task.ps1 exit code: $R9"
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::ExecToLog '"$SYSDIR\schtasks.exe" /Delete /TN "${PRODUCT_NAME} Updater" /F'
    Pop $R9
  ${endIf}
!macroend
