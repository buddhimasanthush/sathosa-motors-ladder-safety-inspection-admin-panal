# Safety Inspection Admin - Windows Desktop Installer

This branch contains the standalone Windows installer:

- **Safety-Inspection-Admin-Setup.zip**: Contains **Safety Inspection Admin Setup 1.0.0.exe**.

---

### How to Install
1. Download and extract **Safety-Inspection-Admin-Setup.zip**.
2. Run **Safety Inspection Admin Setup 1.0.0.exe** to install and open the desktop application.
   - It will automatically create desktop and start menu shortcuts.

---

### How to Uninstall

#### Method 1: Via Windows Settings / Control Panel (Recommended)
1. Open **Windows Settings** (Win + I) -> **Apps** -> **Installed Apps** (or **Add or remove programs**).
2. Search for **Safety Inspection Admin**.
3. Click the three dots (or select it) and click **Uninstall**.

#### Method 2: Via Command Prompt / PowerShell
Run the uninstaller silently or interactively using the installed uninstaller:
`powershell
& "\C:\Users\buddhimas\AppData\Local\Programs\safety-inspection-admin\Uninstall Safety Inspection Admin.exe"
`
*(Or add /S at the end to run it completely silently without prompts)*
