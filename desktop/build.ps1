# Build the desktop installers, signed for the updater.
# Reads TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD from
# the repository's .env (only those two lines; values are never printed),
# builds the web app and the Go sidecar, then runs `pnpm tauri build`.
#   powershell -ExecutionPolicy Bypass -File desktop\build.ps1 [-Version 1.0.1]
param([string]$Version = "")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*(TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)?)\s*=\s*(.*)\s*$') {
      $v = $Matches[3].Trim()
      if ($v.Length -ge 2 -and (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'")))) { $v = $v.Substring(1, $v.Length - 2) }
      Set-Item -Path ("env:" + $Matches[1]) -Value $v
    }
  }
}
if (-not $env:TAURI_SIGNING_PRIVATE_KEY) { Write-Warning "TAURI_SIGNING_PRIVATE_KEY not set: the build will fail at the updater step." }
else { Write-Host "Signing key loaded from .env" }

Push-Location (Join-Path $root "web"); pnpm build; Pop-Location
$ld = "-s -w"; if ($Version) { $ld += " -X rii_music/internal/server.Version=$Version" }
Push-Location $root
go build -trimpath -ldflags $ld -o desktop\src-tauri\binaries\rii_music-x86_64-pc-windows-msvc.exe .
Pop-Location
Push-Location $PSScriptRoot
if ($Version) {
  node -e "const f='src-tauri/tauri.conf.json';const fs=require('fs');const j=JSON.parse(fs.readFileSync(f));j.version=process.argv[1];fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n')" $Version
}
pnpm tauri build
Pop-Location
