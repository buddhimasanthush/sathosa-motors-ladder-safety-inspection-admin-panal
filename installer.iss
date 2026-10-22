; Inno Setup Script for Sathosa Motors Safety Inspection Admin Desktop Application
#define MyAppName "Safety Inspection Admin"
#define MyAppFullName "Sathosa Motors - Safety Inspection Admin Panel"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Sathosa Motors PLC"
#define MyAppURL "https://sathosamotors.lk/"
#define MyAppExeName "SafetyInspectionAdmin.exe"

[Setup]
AppId={{D3F75A19-9B21-4E6D-A2A9-491C78D9C02E}
AppName={#MyAppFullName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\Sathosa Motors\Safety Inspection Admin
DefaultGroupName=Sathosa Motors\Safety Inspection Admin
AllowNoIcons=yes
OutputDir=setup_installer
OutputBaseFilename=SafetyInspectionAdmin-Setup
SetupIconFile=app.ico
UninstallDisplayIcon={app}\app.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=force
RestartApplications=no
DisableWelcomePage=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; Main .NET Desktop executable & backend service
Source: "dist\SafetyInspectionAdmin.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\SafetyAdminBackend.exe"; DestDir: "{app}"; Flags: ignoreversion

; .NET WebView2 Runtime DLLs
Source: "dist\Microsoft.Web.WebView2.WinForms.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\Microsoft.Web.WebView2.Core.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\WebView2Loader.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\runtimes\*"; DestDir: "{app}\runtimes"; Flags: ignoreversion recursesubdirs createallsubdirs

; Tools and Assets
Source: "dist\Configure-Settings.bat"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\app.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\README.txt"; DestDir: "{app}"; Flags: ignoreversion

; Configuration (never overwrite existing database credentials on update/reinstall)
Source: "dist\.env.example"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\.env"; DestDir: "{app}"; Flags: onlyifdoesntexist uninsneveruninstall

; Excel export templates
Source: "dist\*.xlsx"; DestDir: "{app}"; Flags: ignoreversion

; Web application UI assets
Source: "dist\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; Desktop shortcut (launches native .NET desktop app)
Name: "{autodesktop}\{#MyAppFullName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\app.ico"; Tasks: desktopicon

; Start menu shortcuts
Name: "{group}\{#MyAppFullName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\app.ico"
Name: "{group}\Configure Settings (.env)"; Filename: "{app}\Configure-Settings.bat"; WorkingDir: "{app}"
Name: "{group}\Documentation (README)"; Filename: "notepad.exe"; Parameters: """{app}\README.txt"""
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"; IconFilename: "{app}\app.ico"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppFullName}}"; Flags: nowait postinstall skipifsilent
