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

$tempDir = [System.IO.Path]::GetFullPath($env:TEMP)
$installerPath = Join-Path -Path $tempDir -ChildPath $asset.name

Write-Host "Baixando instalador..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $installerPath

Write-Host "Instalando..."
Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait

if (Test-Path -LiteralPath $installerPath) {
    Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
}

$appPath = "$env:LOCALAPPDATA\Programs\ViewCord\ViewCord.exe"
if (Test-Path -LiteralPath $appPath) {
    Write-Host "Abrindo Viewcord na bandeja..."
    Start-Process `
        -FilePath $appPath `
        -ArgumentList "--hidden" `
        -WindowStyle Hidden `
        -RedirectStandardOutput "$env:TEMP\viewcord_stdout.log" `
        -RedirectStandardError "$env:TEMP\viewcord_stderr.log"
} else {
    Write-Host "ViewCord.exe nao encontrado em $appPath"
    Write-Host "Listando conteudo da pasta de instalacao..."
    Get-ChildItem -Path "$env:LOCALAPPDATA\Programs\ViewCord" -ErrorAction SilentlyContinue
}

Write-Host "Viewcord instalado com sucesso!"