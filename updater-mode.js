'use strict';

// Which update path this install uses (pure helpers, unit-tested in test/system-updater.test.js).
//
// Machine-managed: the installer registered the SYSTEM "<productName> Updater" task
// (updater/register-task.ps1) and wrote resources/updater/system-updates.json. The task downloads,
// verifies and silently installs updates once the app is closed in every account, so the app must
// NOT download or quitAndInstall itself: on this per-machine install that path runs elevate.exe and
// asks staff accounts for an admin password.
// Legacy: no marker (a build without the task, a failed registration, or a dev run). Then
// electron-updater keeps its old auto-download + install-on-quit behaviour.
//
// SYNC: system-updates-marker - updater/register-task.ps1 writes this marker; keep the file name and
// the {taskName, version} shape in step.

const fs = require('fs');
const path = require('path');

const MARKER = path.join('updater', 'system-updates.json');
// Same rule register-task.ps1 enforces; the name ends up as a schtasks.exe argument.
const TASK_NAME_RE = /^[A-Za-z0-9 ._-]{1,64}$/;

function readSystemUpdater(resourcesPath, fsImpl = fs) {
  if (!resourcesPath) return null;
  let raw;
  try { raw = fsImpl.readFileSync(path.join(resourcesPath, MARKER), 'utf8'); } catch { return null; }
  let m;
  try { m = JSON.parse(String(raw).replace(/^﻿/, '')); } catch { return null; }
  if (!m || typeof m.taskName !== 'string' || !TASK_NAME_RE.test(m.taskName)) return null;
  return { taskName: m.taskName, version: typeof m.version === 'string' ? m.version : null };
}

function updaterSettings(systemUpdater) {
  return systemUpdater
    ? { autoDownload: false, autoInstallOnAppQuit: false }
    : { autoDownload: true, autoInstallOnAppQuit: true };
}

// Starts the SYSTEM task now (Users have read+run on it, nothing else). The task waits up to 90 s
// for every copy of the app to exit, so it can be fired while this process is still quitting.
function runTaskCommand(taskName) {
  return { file: 'schtasks.exe', args: ['/Run', '/TN', taskName] };
}

module.exports = { readSystemUpdater, updaterSettings, runTaskCommand, MARKER };
