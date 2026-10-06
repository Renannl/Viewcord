# Uso para instalar:
# iwr -useb https://raw.githubusercontent.com/Renannl/Viewcord/main/install.ps1 | iex

$ErrorActionPreference = "Stop"
$repository = "Renannl/Viewcord"

Write-Host "Buscando a versão mais recente do ViewCord..."

$release = Invoke-RestMethod `
  -Uri "https://api.github.com/repos/$repository/releases/latest" `
  -Headers @{ "User-Agent" = "Viewcord-Installer" }

$installerAsset = $release.assets |
  Where-Object { $_.name -match "(?i)setup.*\.exe$" } |
  Select-Object -First 1

if (-not $installerAsset) {
  throw "Não encontrei o instalador Setup .exe na release mais recente do GitHub."
}

$installerPath = Join-Path $env:TEMP $installerAsset.name

Write-Host "Baixando $($installerAsset.name)..."
Invoke-WebRequest `
  -Uri $installerAsset.browser_download_url `
  -OutFile $installerPath

Write-Host "Abrindo o instalador do ViewCord..."
Start-Process -FilePath $installerPath -Wait

Remove-Item $installerPath -Force -ErrorAction SilentlyContinue
Write-Host "Concluído."