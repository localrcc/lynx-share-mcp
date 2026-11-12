param([string]$Zig = 'zig')
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    New-Item -ItemType Directory -Force dist | Out-Null
    & $Zig cc -target x86_64-windows-gnu -O2 -s midi-out.c -o dist/midi-out.exe -lwinmm
    if ($LASTEXITCODE) { throw 'MIDI helper build failed' }
    & $Zig cc -target x86_64-windows-gnu -O2 -s -shared -I third_party/clap/include plugin/utility.c -o dist/LYNX-Project-Utility.clap -luser32 -lgdi32 -lcomdlg32 -lwinmm
    if ($LASTEXITCODE) { throw 'CLAP build failed' }
    Copy-Item -LiteralPath server.mjs,live.mjs,audio.mjs,music.mjs,lynx.mjs,README.md -Destination dist
    Copy-Item -LiteralPath docs -Destination dist -Recurse -Force
} finally {
    Pop-Location
}
