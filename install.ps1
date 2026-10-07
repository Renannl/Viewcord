# iwr -useb https://raw.githubusercontent.com/Renannl/Viewcord/main/install.ps1 | iex

$ErrorActionPreference = "Stop"
$repository = "Renannl/Viewcord"
$installerName = "ViewCord-Setup-0.1.0.exe"

Write-Host "Buscando a versão mais recente do ViewCord..."

$release = Invoke-RestMethod `
  -Uri "https://api.github.com/repos/$repository/releases/latest" `
  -Headers @{ "User-Agent" = "Viewcord-Installer" }

$asset = $release.assets |
  Where-Object { $_.name -eq $installerName } |
  Select-Object -First 1

if (-not $asset) {
  throw "Não encontrei o arquivo $installerName na release mais recente."
}

$installerPath = Join-Path $env:TEMP $asset.name

Write-Host "Baixando instalador..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installerPath

Write-Host "Instalando silenciosamente..."
Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait

Remove-Item $installerPath -Force -ErrorAction SilentlyContinue
Write-Host "ViewCord instalado com sucesso!"
