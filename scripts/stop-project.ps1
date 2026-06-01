$ErrorActionPreference = "SilentlyContinue"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

Write-Host "Deteniendo contenedores Docker..."
docker compose down --remove-orphans *> $null
Write-Host "Proyecto detenido."
