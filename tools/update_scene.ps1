# Put the newest school .blend on the site: export -> gltfpack -> floor light map.
#   powershell -ExecutionPolicy Bypass -File tools\update_scene.ps1 [-Blend ..\NIS_3D_plan\NIS_v09.blend]
# Without -Blend the newest NIS_v*.blend in ..\NIS_3D_plan is used.
param([string]$Blend = "")
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)
$B = "C:\Program Files (x86)\Steam\steamapps\common\Blender\blender.exe"
if (-not $Blend) {
    $Blend = (Get-ChildItem ..\NIS_3D_plan -Filter "NIS_v*.blend" | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}
Write-Host "Scene: $Blend"
New-Item -ItemType Directory -Force build | Out-Null
& $B -b $Blend --python-exit-code 2 -P tools/export_scene.py -- build/school-raw.glb
if ($LASTEXITCODE) { throw "Web geometry export failed" }
# -km keeps material names (interior.js shades by name); -vp 16 = ~2 mm position steps,
# the default 14 bits (~8 mm over the building) sinks thin decals into walls and floors (flicker).
npx gltfpack -i build/school-raw.glb -o build/school.glb -km -vp 16 -cc -mi
if ($LASTEXITCODE) { throw "Mesh compression failed" }
& $B -b $Blend --python-exit-code 2 -P tools/bake_floor_light.py -- build/floor-light.npy
if ($LASTEXITCODE) { throw "Floor visibility bake failed" }
python tools/finish_floor_light.py build/floor-light.npy build/floor-light.png dist/floor-light.png
if ($LASTEXITCODE) { throw "Floor texture encoding failed" }
& $B -b $Blend --python-exit-code 2 -P tools/bake_atrium.py -- build
if ($LASTEXITCODE) { throw "Atrium light bake failed" }
Copy-Item build/atrium-probe.hdr,build/atrium-light.png,build/atrium-ceiling.png,build/atrium-lamps.json dist -Force
Copy-Item build/school.glb dist/school.glb -Force
Copy-Item build/floor-light.png dist/floor-light.png -Force
Write-Host "dist/school.glb and dist/floor-light.png updated"
