# iwr -useb https://raw.githubusercontent.com/Renannl/Viewcord/main/install.ps1 | iex

$ErrorActionPreference = "Stop"
$repository = "Renannl/Viewcord"

Write-Host "Buscando a versao mais recente do Viewcord..."

$release = Invoke-RestMethod `
  -Uri "https://api.github.com/repos/$repository/releases/latest" `
  -Headers @{ "User-Agent" = "Viewcord-Installer" }

$asset = $release.assets |
  Where-Object { $_.name -like "*.exe" } |
  Select-Object -First 1

if (-not $asset) {
  throw "Não encontrei nenhum arquivo .exe na release mais recente."
}

Write-Host "Arquivo encontrado: $($asset.name)"

$installerPath = [System.IO.Path]::Combine($env:TEMP, $asset.name)

Write-Host "Baixando instalador..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installerPath

Write-Host "Instalando..."
Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait

if (Test-Path -LiteralPath $installerPath) {
    Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
}

Write-Host "Viewcord instalado com sucesso!"