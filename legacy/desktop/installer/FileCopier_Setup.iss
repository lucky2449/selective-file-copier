; Inno Setup 스크립트 — 파일복사 프로그램 설치 프로그램
; 빌드 전 준비: dist/FileCopier.exe 와 icon.ico 가 프로젝트 루트에 있어야 합니다.
; 컴파일: python utils/build_exe.py 로 자동 빌드됩니다.
; Inno Setup 다운로드: https://jrsoftware.org/isdl.php

#define AppName "FileCopier"
#define AppPublisher "your-name"
#define AppExeName "FileCopier.exe"

[Setup]
AppId={{A1B2C3D4-E5F6-7890-ABCD-EF1234567890}
AppName={#AppName}
AppVerName={#AppName}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\FileCopier
DefaultGroupName={#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputDir=..\installer_output
OutputBaseFilename=FileCopier_download
SetupIconFile=..\icon.ico
Compression=lzma
SolidCompression=yes
WizardStyle=modern
; 관리자 권한 불필요 — 사용자 폴더에 설치
PrivilegesRequired=lowest

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Files]
Source: "..\dist\{#AppExeName}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{group}\{#AppName} 제거"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"

[Run]
Filename: "{app}\{#AppExeName}"; Description: "설치 완료 후 바로 실행"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
