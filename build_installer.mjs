/**
 * Build script for Sathosa Motors Safety Inspection Admin Setup Installer
 * Uses Inno Setup (ISCC.exe) via innosetup-compiler
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const PROJECT = 'C:/Users/buddhimas/Desktop/projects/Safety-Inspection-Admin';
const DIST = path.join(PROJECT, 'dist');
const BACKEND_TARGET = path.join(DIST, 'SafetyAdminBackend.exe');
const DOTNET_TARGET = path.join(DIST, 'SafetyInspectionAdmin.exe');
const ISS_FILE = path.join(PROJECT, 'installer.iss');
const ISCC_EXE = path.join(PROJECT, 'node_modules', 'innosetup-compiler', 'bin', 'ISCC.exe');
const OUTPUT_DIR = path.join(PROJECT, 'setup_installer');
const SETUP_EXE = path.join(OUTPUT_DIR, 'SafetyInspectionAdmin-Setup.exe');

console.log('========================================================');
console.log(' Building Sathosa Motors Safety Inspection Setup Installer');
console.log('========================================================\n');

// Step 1: Ensure dist and executables exist
if (!fs.existsSync(BACKEND_TARGET) || !fs.existsSync(DOTNET_TARGET)) {
  console.log('⏳ Building desktop application and backend...');
  execSync('node build_exe.mjs', { stdio: 'inherit', cwd: PROJECT });
} else {
  console.log('✔ Found existing desktop app and backend in dist/');
}

// Step 2: Ensure Inno Setup Compiler exists
if (!fs.existsSync(ISCC_EXE)) {
  console.error('❌ Error: Inno Setup Compiler (ISCC.exe) not found at: ' + ISCC_EXE);
  console.error('Please run: npm install --save-dev innosetup-compiler');
  process.exit(1);
}

// Step 3: Run Inno Setup Compiler
console.log('\n⏳ Compiling Windows Setup Installer with Inno Setup...');
try {
  execSync(`"${ISCC_EXE}" "${ISS_FILE}"`, { stdio: 'inherit', cwd: PROJECT });
} catch (err) {
  console.error('❌ Compilation failed:', err.message);
  process.exit(1);
}

// Step 4: Verify installer creation
if (fs.existsSync(SETUP_EXE)) {
  const stats = fs.statSync(SETUP_EXE);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  
  console.log('\n══════════════════════════════════════════════════════');
  console.log('🎉 SETUP INSTALLER SUCCESSFULLY CREATED!');
  console.log('══════════════════════════════════════════════════════');
  console.log('Setup File: ' + SETUP_EXE);
  console.log('Size:       ' + sizeMB + ' MB');
  console.log('Location:   ' + OUTPUT_DIR);
  console.log('======================================================');
  console.log('When installed on any Windows machine:');
  console.log('1. It runs directly as a .NET Desktop Window (WinForms + WebView2)');
  console.log('2. Zero console / terminal windows');
  console.log('3. Zero web browser tabs or browser chrome');
  console.log('4. Standard desktop window with minimize, maximize, and close');
  console.log('======================================================\n');
} else {
  console.error('❌ Expected setup file was not created: ' + SETUP_EXE);
  process.exit(1);
}
