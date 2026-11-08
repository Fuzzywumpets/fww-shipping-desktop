'use strict';

// Machine-managed updates (SYSTEM task) instead of electron-updater's elevating quitAndInstall.
// Checks the pure helpers in updater-mode.js and the couplings between package.json,
// build/installer.nsh, updater/*.ps1 and main.js that a broken build would only show on a real PC.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readSystemUpdater, updaterSettings, runTaskCommand, MARKER } = require('../updater-mode');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));
const nsh = read('build/installer.nsh');
const registerPs1 = read('updater/register-task.ps1');
const updatePs1 = read('updater/fww-update.ps1');
const mainJs = read('main.js');

const fakeFs = (files) => ({
  readFileSync(p) {
    if (!(p in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
    return files[p];
  },
});
const markerAt = (dir) => path.join(dir, MARKER);

test('readSystemUpdater: a valid marker means machine-managed', () => {
  const fsx = fakeFs({ [markerAt('R')]: '{"taskName":"FWW Shipping Updater","version":"1.0.24"}' });
  assert.deepEqual(readSystemUpdater('R', fsx), { taskName: 'FWW Shipping Updater', version: '1.0.24' });
});

test('readSystemUpdater: tolerates the BOM Windows PowerShell may write', () => {
  const fsx = fakeFs({ [markerAt('R')]: '\uFEFF{"taskName":"FWW Shipping Updater"}' });
  assert.deepEqual(readSystemUpdater('R', fsx), { taskName: 'FWW Shipping Updater', version: null });
});

test('readSystemUpdater: no marker, bad JSON or an unsafe task name means legacy', () => {
  assert.equal(readSystemUpdater('R', fakeFs({})), null);
  assert.equal(readSystemUpdater('', fakeFs({})), null);
  assert.equal(readSystemUpdater('R', fakeFs({ [markerAt('R')]: 'not json' })), null);
  assert.equal(readSystemUpdater('R', fakeFs({ [markerAt('R')]: '{"taskName":""}' })), null);
  assert.equal(readSystemUpdater('R', fakeFs({ [markerAt('R')]: '{"taskName":"x\\" & calc"}' })), null);
  assert.equal(readSystemUpdater('R', fakeFs({ [markerAt('R')]: '{"version":"1.0.24"}' })), null);
});

test('updaterSettings: machine-managed never lets electron-updater download or install', () => {
  assert.deepEqual(updaterSettings({ taskName: 'T' }), { autoDownload: false, autoInstallOnAppQuit: false });
  assert.deepEqual(updaterSettings(null), { autoDownload: true, autoInstallOnAppQuit: true });
});

test('runTaskCommand: schtasks /Run with the name as one argument (no shell)', () => {
  assert.deepEqual(runTaskCommand('FWW Shipping Updater'), { file: 'schtasks.exe', args: ['/Run', '/TN', 'FWW Shipping Updater'] });
});

test('build config: per-machine NSIS with the updater hook and scripts', () => {
  assert.equal(pkg.build.nsis.perMachine, true, 'README: never revert to per-user');
  assert.equal(pkg.build.nsis.include, 'build/installer.nsh');
  assert.ok(pkg.build.files.includes('updater-mode.js'), 'updater-mode.js must ship (main.js requires it)');
  const er = pkg.build.extraResources.find((e) => e.from === 'updater');
  assert.ok(er, 'extraResources must copy updater/');
  assert.equal(er.to, 'updater');
  for (const f of ['fww-update.ps1', 'register-task.ps1']) {
    assert.ok(er.filter.includes(f), `${f} must ship`);
    assert.ok(fs.existsSync(path.join(root, 'updater', f)), `${f} must exist`);
  }
});

test('SYNC updater-task-name: install and uninstall use the same task name', () => {
  const registered = nsh.match(/register-task\.ps1".*-TaskName "([^"]+)"/);
  const deleted = nsh.match(/schtasks\.exe" \/Delete \/TN "([^"]+)"/);
  assert.ok(registered && deleted, 'both macros must name the task');
  assert.equal(registered[1], deleted[1]);
  assert.equal(registered[1], '${PRODUCT_NAME} Updater');
});

test('uninstall keeps the task during an update (--updated)', () => {
  const un = nsh.slice(nsh.indexOf('!macro customUnInstall'));
  assert.match(un, /\$\{ifNot\} \$\{isUpdated\}[\s\S]*schtasks\.exe" \/Delete/);
});

test('register-task.ps1 passes the parameters fww-update.ps1 declares', () => {
  for (const p of ['InstallDir', 'AppExe', 'FeedUrl']) {
    assert.match(registerPs1, new RegExp(`-${p} \``), `register-task.ps1 must pass -${p}`);
    assert.match(updatePs1, new RegExp(`\\[string\\]\\$${p}\\b`), `fww-update.ps1 must declare -${p}`);
  }
  assert.match(registerPs1, /system-updates\.json/);
  assert.equal(MARKER, path.join('updater', 'system-updates.json'));
});

test('task runs as SYSTEM and Users may only read + run it', () => {
  assert.match(registerPs1, /New-ScheduledTaskPrincipal -UserId 'S-1-5-18'/);
  assert.match(registerPs1, /SetSecurityDescriptor\('D:\(A;;FA;;;BA\)\(A;;FA;;;SY\)\(A;;GRGX;;;BU\)', 0\)/);
});

test('fww-update.ps1 never installs while the app runs and verifies sha512 first', () => {
  const inv = updatePs1.slice(updatePs1.indexOf('function Invoke-Update'));
  const iHash = inv.indexOf('Get-Sha512Base64 $installer');
  const iWait = inv.indexOf('Get-AppProcesses).Count -gt 0');
  const iRun = inv.indexOf("Start-Process -FilePath $installer");
  assert.ok(iHash > 0 && iWait > iHash && iRun > iWait, 'order must be: verify hash, wait for app exit, run');
  assert.match(inv, /'\/S', '--updated', '--fww-system-update'/);
  const iLast = inv.indexOf('Get-AppProcesses).Count -gt 0', iWait + 1);
  assert.ok(iLast > iWait && iLast < iRun, 'a last process check sits right before the installer');
  assert.match(inv, /ExitCode -eq 75\) \{ Write-Log "deferred/);
  assert.doesNotMatch(updatePs1, /\$(actual|feed\.sha512)[^\n]*\s-ne\s/, 'Base64 hashes must be compared case-sensitively (-cne)');
});

test('SYNC system-update-defer: the installer defers (exit 75) instead of force-closing when the updater runs it', () => {
  const m = nsh.slice(nsh.indexOf('!macro customCheckAppRunning'), nsh.indexOf('!macroend', nsh.indexOf('!macro customCheckAppRunning')));
  assert.match(m, /\$\{GetOptions\} \$R0 "--fww-system-update" \$R1/);
  assert.match(m, /\$\{if\} \$\{Errors\}\s+!insertmacro _CHECK_APP_RUNNING/, 'without the flag keep the default behaviour');
  assert.match(m, /SetErrorLevel 75\s+Quit/);
});

test('main.js: machine-managed mode returns before the legacy dialogs and never calls quitAndInstall itself', () => {
  const fn = mainJs.slice(mainJs.indexOf('function setupAutoUpdater'), mainJs.indexOf('// ─── Test print content'));
  assert.match(fn, /readSystemUpdater\(process\.resourcesPath\)/);
  assert.match(fn, /autoUpdater\.autoDownload\s+= settings\.autoDownload/);
  assert.match(fn, /autoUpdater\.autoInstallOnAppQuit = settings\.autoInstallOnAppQuit/);
  const avail = fn.slice(fn.indexOf("autoUpdater.on('update-available'"), fn.indexOf("autoUpdater.on('update-not-available'"));
  const sysBranch = avail.slice(avail.indexOf('if (systemUpdater) {'), avail.indexOf('return;\n    }') + 1);
  assert.ok(sysBranch.length > 20, 'machine-managed branch present');
  assert.doesNotMatch(sysBranch, /quitAndInstall/);
  assert.match(fn, /app\.on\('will-quit'[\s\S]*runTaskCommand\(systemUpdater\.taskName\)/);
});

test('PowerShell scripts: no "$name:" inside strings (PS 5.1 parses it as a drive/scope and the script fails to load)', () => {
  const scopes = new Set(['env', 'script', 'global', 'local', 'private', 'using', 'function', 'variable']);
  for (const f of ['updater/fww-update.ps1', 'updater/register-task.ps1', 'test/fww-update.tests.ps1']) {
    const bad = [...read(f).matchAll(/\$([A-Za-z_][A-Za-z0-9_]*):(?!:)/g)].filter((m) => !scopes.has(m[1].toLowerCase()));
    assert.deepEqual(bad.map((m) => m[0]), [], `${f}: use \${name}: instead`);
  }
});

test('installer.nsh provides what the default app-running check needs once customCheckAppRunning exists', () => {
  assert.match(nsh, /!include "getProcessInfo\.nsh"\s+Var pid\s+!macro customCheckAppRunning/);
});
