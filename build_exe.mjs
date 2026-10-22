/**
 * Build script for Sathosa Motors - Safety Inspection Admin Desktop Application
 * Strategy:
 * 1. esbuild bundles server.js (ESM) -> dist/bundle.cjs
 * 2. pkg packages bundle.cjs -> dist/SafetyAdminBackend.exe
 * 3. csc.exe compiles C# .NET Windows Forms desktop wrapper -> dist/SafetyInspectionAdmin.exe
 * 4. WebView2 runtime libraries & assets copied into dist/
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const PROJECT = 'C:/Users/buddhimas/Desktop/projects/Safety-Inspection-Admin';
const DIST = path.join(PROJECT, 'dist');
const BUNDLE_CJS = path.join(DIST, 'bundle.cjs');
const CSC_EXE = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe';

console.log('========================================================');
console.log(' Building Sathosa Motors Desktop Application (.NET + WebView2)');
console.log('========================================================\n');

// ─── Step 0: Clean dist (preserving .env if modified) ────────────
let existingEnv = null;
if (fs.existsSync(path.join(DIST, '.env'))) {
  try { existingEnv = fs.readFileSync(path.join(DIST, '.env'), 'utf8'); } catch(e) {}
}

if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true, force: true });
}
fs.mkdirSync(DIST, { recursive: true });
console.log('✔ Cleaned dist/');

// ─── Step 1: Read and patch server.js for exe compatibility ─────
console.log('⏳ Preparing backend server code...');
let serverCode = fs.readFileSync(path.join(PROJECT, 'server.js'), 'utf8');

const patchedHeader = `// ══════ BACKEND SERVICE ENTRY POINT ══════
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');

const isExe = !path.basename(process.execPath).toLowerCase().startsWith('node');
const __exeDir = isExe ? path.dirname(process.execPath) : __dirname;

const envPath = path.join(__exeDir, '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  require('dotenv').config();
}

const ExcelJS = require('exceljs');
const express = require('express');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const pg = require('pg');
const XLSX = require('xlsx');

const { Pool } = pg;

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
const sessions = new Set();
`;

const getTablesIdx = serverCode.indexOf('function getTables(req)');
if (getTablesIdx === -1) {
  console.error('Could not find getTables function in server.js');
  process.exit(1);
}

let bodyCode = serverCode.substring(getTablesIdx);
bodyCode = bodyCode.replace(/\b__dirname\b/g, '__exeDir');
bodyCode = bodyCode.replace(/export\s+default\s+app;\s*$/, '');

const listenPattern = /const\s+port\s*=\s*Number\(process\.env\.PORT\s*\|\|\s*8081\);[\s\S]*$/;
const enhancedListen = `
const port = Number(process.env.PORT || 8082);

const server = app.listen(port, () => {
  const url = 'http://localhost:' + port;
  console.log('Sathosa Motors Safety Inspection Service listening on ' + url);
  if (process.env.AUTO_OPEN === 'true' && process.platform === 'win32') {
    try { exec('start ' + url); } catch (e) {}
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + port + ' is already in use.');
  } else {
    console.error('Server error:', err);
  }
});
`;

bodyCode = bodyCode.replace(listenPattern, enhancedListen);
const finalCode = patchedHeader + '\n' + bodyCode;
const patchedPath = path.join(DIST, 'server_patched.cjs');
fs.writeFileSync(patchedPath, finalCode, 'utf8');
console.log('✔ Prepared patched server code');

// ─── Step 2: Bundle with esbuild ────────────────────────────────
console.log('⏳ Bundling backend with esbuild...');
execSync(
  `npx -y esbuild "${patchedPath}" ` +
  `--bundle ` +
  `--platform=node ` +
  `--format=cjs ` +
  `--outfile="${BUNDLE_CJS}" ` +
  `--external:pg-native ` +
  `--target=node20`,
  { stdio: 'inherit', cwd: PROJECT }
);
console.log('✔ Backend bundled → dist/bundle.cjs');

// ─── Step 3: Build backend executable ───────────────────────────
console.log('⏳ Packaging backend into SafetyAdminBackend.exe...');
const backendTarget = path.join(DIST, 'SafetyAdminBackend.exe');

try {
  execSync(
    `npx -y @yao-pkg/pkg "${BUNDLE_CJS}" --sea -t node24-win-x64 -o "${backendTarget}"`,
    { stdio: 'inherit', cwd: PROJECT }
  );
  console.log('✔ SafetyAdminBackend.exe created (SEA)');
} catch (seaErr) {
  console.log('Falling back to standard pkg...');
  execSync(
    `npx -y @yao-pkg/pkg "${BUNDLE_CJS}" -t node24-win-x64 -o "${backendTarget}" --compress GZip`,
    { stdio: 'inherit', cwd: PROJECT }
  );
  console.log('✔ SafetyAdminBackend.exe created (pkg)');
}

// ─── Step 4: Compile .NET Windows Forms Desktop Application ─────
console.log('⏳ Compiling .NET Windows Desktop Application (SafetyInspectionAdmin.exe)...');
const dotnetSrc = path.join(PROJECT, 'src_dotnet', 'Program.cs');
const netExeTarget = path.join(DIST, 'SafetyInspectionAdmin.exe');
const icoPath = path.join(PROJECT, 'app.ico');

const cscCmd = `"${CSC_EXE}" ` +
  `/target:winexe ` +
  `/out:"${netExeTarget}" ` +
  `/win32icon:"${icoPath}" ` +
  `/r:System.dll,System.Core.dll,System.Drawing.dll,System.Windows.Forms.dll,` +
  `"${path.join(PROJECT, 'lib', 'Microsoft.Web.WebView2.WinForms.dll')}",` +
  `"${path.join(PROJECT, 'lib', 'Microsoft.Web.WebView2.Core.dll')}" ` +
  `"${dotnetSrc}"`;

execSync(cscCmd, { stdio: 'inherit', cwd: PROJECT });
console.log('✔ Compiled .NET Windows Desktop Application → dist/SafetyInspectionAdmin.exe');

// ─── Step 5: Copy WebView2 libraries and assets into dist ───────
console.log('⏳ Copying dependencies and assets...');

// Copy WebView2 DLLs
fs.copyFileSync(
  path.join(PROJECT, 'lib', 'Microsoft.Web.WebView2.WinForms.dll'),
  path.join(DIST, 'Microsoft.Web.WebView2.WinForms.dll')
);
fs.copyFileSync(
  path.join(PROJECT, 'lib', 'Microsoft.Web.WebView2.Core.dll'),
  path.join(DIST, 'Microsoft.Web.WebView2.Core.dll')
);
fs.copyFileSync(
  path.join(PROJECT, 'lib', 'WebView2Loader.dll'),
  path.join(DIST, 'WebView2Loader.dll')
);

// Copy runtimes folder for WebView2 x64 loader
const destRuntimes = path.join(DIST, 'runtimes', 'win-x64', 'native');
fs.mkdirSync(destRuntimes, { recursive: true });
fs.copyFileSync(
  path.join(PROJECT, 'lib', 'WebView2Loader.dll'),
  path.join(destRuntimes, 'WebView2Loader.dll')
);
console.log('  ✔ WebView2 libraries copied');

// Copy public web assets
const destPublic = path.join(DIST, 'public');
fs.mkdirSync(destPublic, { recursive: true });
for (const f of fs.readdirSync(path.join(PROJECT, 'public'))) {
  fs.copyFileSync(path.join(PROJECT, 'public', f), path.join(destPublic, f));
}
console.log('  ✔ public/ copied');

// Copy essential xlsx templates
const xlsxFiles = [
  'template.xlsx',
  'fire_extinguisher_template.xlsx',
  'firstaid_template.xlsx'
];
for (const f of xlsxFiles) {
  const src = path.join(PROJECT, f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(DIST, f));
    console.log('  ✔ ' + f);
  }
}

// Copy .env & .env.example
const envExample = path.join(PROJECT, '.env.example');
if (fs.existsSync(envExample)) {
  fs.copyFileSync(envExample, path.join(DIST, '.env.example'));
  console.log('  ✔ .env.example');
}

const envFile = path.join(PROJECT, '.env');
if (fs.existsSync(envFile)) {
  fs.copyFileSync(envFile, path.join(DIST, '.env'));
  console.log('  ✔ .env');
} else if (existingEnv) {
  fs.writeFileSync(path.join(DIST, '.env'), existingEnv, 'utf8');
  console.log('  ✔ .env (preserved)');
}

// Copy app.ico
if (fs.existsSync(icoPath)) {
  fs.copyFileSync(icoPath, path.join(DIST, 'app.ico'));
  console.log('  ✔ app.ico');
}

// Create settings configuration batch file
const configBat = `@echo off
title Sathosa Motors - Safety Inspection Settings (.env)
cd /d "%~dp0"
echo Opening configuration file (.env) in Notepad...
if not exist .env (
  if exist .env.example (
    copy .env.example .env >nul
  )
)
notepad.exe .env
`;
fs.writeFileSync(path.join(DIST, 'Configure-Settings.bat'), configBat, 'utf8');
console.log('  ✔ Configure-Settings.bat');

// Create README.txt
const readmeContent = `========================================================
SATHOSA MOTORS - SAFETY INSPECTION ADMIN DESKTOP APPLICATION
========================================================

Description:
A standalone native Windows desktop application for managing 
Sathosa Motors safety inspection records and questionnaires.

How to Run:
1. Double-click "SafetyInspectionAdmin.exe".
2. The native desktop application window will open directly.
3. When you close the window, the application and background
   service automatically shut down cleanly.

Desktop & Start Menu Shortcuts:
- "Safety Inspection Admin Panel" : Launches the desktop application
- "Configure Settings (.env)"     : Opens configuration in Notepad

Configuration (.env):
You can adjust database credentials or admin password anytime
in the .env file. Changes take effect on the next launch.
`;
fs.writeFileSync(path.join(DIST, 'README.txt'), readmeContent, 'utf8');
console.log('  ✔ README.txt');

// ─── Step 6: Clean temp files ───────────────────────────────────
try { fs.unlinkSync(patchedPath); } catch(e) {}
try { fs.unlinkSync(BUNDLE_CJS); } catch(e) {}

console.log('\n══════════════════════════════════════════════════════');
console.log('✅ DESKTOP BUILD COMPLETE!');
console.log('══════════════════════════════════════════════════════');
console.log('Desktop App: ' + netExeTarget);
console.log('Backend:     ' + backendTarget);
console.log('Folder:      ' + DIST);
console.log('======================================================\n');
