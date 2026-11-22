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
& $B -b $Blend -P tools/export_scene.py -- build/school-raw.glb
npx gltfpack -i build/school-raw.glb -o build/school.glb -km    # -km keeps material names (interior.js shades by name)
& $B -b $Blend -P tools/bake_floor_light.py -- build/floor-light.npy
python tools/finish_floor_light.py build/floor-light.npy build/floor-light.png dist/floor-light.png
Copy-Item build/school.glb dist/school.glb -Force
Copy-Item build/floor-light.png dist/floor-light.png -Force
Write-Host "dist/school.glb and dist/floor-light.png updated"
