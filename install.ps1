# iwr -useb https://raw.githubusercontent.com/Renannl/Viewcord/main/install.ps1 | iex

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$repository = "Renannl/Viewcord"
$appNamePattern = '(?i)^ViewCord(?:\s|$)'

function Get-ViewCordUninstallEntries {
    $registryPaths = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )

    $loadedUserSids = Get-ChildItem "Registry::HKEY_USERS" -ErrorAction SilentlyContinue |
        Where-Object { $_.PSChildName -match '^S-1-5-' } |
        ForEach-Object { $_.PSChildName }

    foreach ($sid in $loadedUserSids) {
        $registryPaths += @(
            "Registry::HKEY_USERS\$sid\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
            "Registry::HKEY_USERS\$sid\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
        )
    }

    foreach ($registryPath in $registryPaths) {
        Get-ItemProperty -Path $registryPath -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -match $appNamePattern }
    }
}

function Stop-ViewCordProcesses {
    Get-Process -Name "ViewCord" -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
}

function Invoke-ViewCordUninstaller {
    param([Parameter(Mandatory = $true)] $Entry)

    $command = [string]$Entry.QuietUninstallString
    if ([string]::IsNullOrWhiteSpace($command)) {
        $command = [string]$Entry.UninstallString
    }

    if ([string]::IsNullOrWhiteSpace($command)) {
        Write-Warning "Sem comando de desinstalação para $($Entry.DisplayName)."
        return
    }

    $command = [Environment]::ExpandEnvironmentVariables($command).Trim()

    if ($command -match '^\s*"([^"]+)"\s*(.*)$') {
        $filePath = $matches[1]
        $arguments = $matches[2].Trim()
    } elseif ($command -match '^\s*(.+?\.exe)\s*(.*)$') {
        $filePath = $matches[1].Trim()
        $arguments = $matches[2].Trim()
    } else {
        Write-Warning "Não consegui interpretar o desinstalador: $command"
        return
    }

    if (-not (Test-Path -LiteralPath $filePath)) {
        Write-Warning "Desinstalador não encontrado: $filePath"
        return
    }

    if ([IO.Path]::GetFileName($filePath) -match '(?i)^msiexec\.exe$') {
        $arguments = $arguments -replace '(?i)/I(?=\s|{)', '/X'
        if ($arguments -notmatch '(?i)/q') {
            $arguments = "$arguments /qn"
        }
        if ($arguments -notmatch '(?i)/norestart') {
            $arguments = "$arguments /norestart"
        }
    } elseif ($arguments -notmatch '(?i)(^|\s)/S(\s|$)') {
        $arguments = "$arguments /S".Trim()
    }

    try {
        Write-Host "Desinstalando $($Entry.DisplayName) silenciosamente..."
        Start-Process `
            -FilePath $filePath `
            -ArgumentList $arguments `
            -WindowStyle Hidden `
            -Wait
    } catch {
        Write-Warning "Falha ao desinstalar $($Entry.DisplayName): $($_.Exception.Message)"
    }
}

function Remove-ViewCordInstallFolder {
    param([Parameter(Mandatory = $true)][string] $Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return
    }

    try {
        $expandedPath = [Environment]::ExpandEnvironmentVariables($Path.Trim().Trim('"'))
        $fullPath = [IO.Path]::GetFullPath($expandedPath)
    } catch {
        return
    }

    if ([IO.Path]::GetFileName($fullPath.TrimEnd('\')) -ine "ViewCord") {
        return
    }

    if (Test-Path -LiteralPath $fullPath) {
        try {
            Write-Host "Removendo pasta antiga: $fullPath"
            Remove-Item -LiteralPath $fullPath -Recurse -Force
        } catch {
            Write-Warning "Não foi possível remover $fullPath. Tente executar como administrador."
        }
    }
}

function Get-ViewCordExecutableCandidates {
    param([object[]] $Entries)

    $candidates = [System.Collections.Generic.List[string]]::new()

    foreach ($entry in $Entries) {
        if ($entry.InstallLocation) {
            $candidates.Add((Join-Path ([string]$entry.InstallLocation) "Viewcord.exe"))
        }

        if ($entry.DisplayIcon) {
            $iconPath = [string]$entry.DisplayIcon
            if ($iconPath -match '^\s*"([^"]+\.exe)"') {
                $candidates.Add($matches[1])
            } elseif ($iconPath -match '^\s*(.+?\.exe)(?:,\d+)?\s*$') {
                $candidates.Add($matches[1].Trim())
            }
        }
    }

    $candidates.Add((Join-Path $env:LOCALAPPDATA "Programs\ViewCord\Viewcord.exe"))
    $candidates.Add((Join-Path $env:ProgramFiles "ViewCord\Viewcord.exe"))

    if (${env:ProgramFiles(x86)}) {
        $candidates.Add((Join-Path ${env:ProgramFiles(x86)} "ViewCord\Viewcord.exe"))
    }

    $usersRoot = Join-Path $env:SystemDrive "Users"
    if (Test-Path -LiteralPath $usersRoot) {
        Get-ChildItem -LiteralPath $usersRoot -Directory -ErrorAction SilentlyContinue |
            ForEach-Object {
                $candidates.Add(
                    (Join-Path $_.FullName "AppData\Local\Programs\ViewCord\Viewcord.exe")
                )
            }
    }

    $candidates |
        Where-Object { $_ } |
        Select-Object -Unique
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Warning "O PowerShell não está como administrador. Instalações de outros usuários ou do sistema podem permanecer."
}

Write-Host "Fechando o ViewCord que estiver aberto..."
Stop-ViewCordProcesses

Write-Host "Procurando instalações antigas..."
$oldEntries = @(Get-ViewCordUninstallEntries)

foreach ($entry in $oldEntries) {
    Invoke-ViewCordUninstaller -Entry $entry
}

Start-Sleep -Seconds 2
Stop-ViewCordProcesses

$foldersToRemove = @(
    (Join-Path $env:LOCALAPPDATA "Programs\ViewCord"),
    (Join-Path $env:ProgramFiles "ViewCord")
)

if (${env:ProgramFiles(x86)}) {
    $foldersToRemove += Join-Path ${env:ProgramFiles(x86)} "ViewCord"
}

$usersRoot = Join-Path $env:SystemDrive "Users"
if (Test-Path -LiteralPath $usersRoot) {
    Get-ChildItem -LiteralPath $usersRoot -Directory -ErrorAction SilentlyContinue |
        ForEach-Object {
            $foldersToRemove += Join-Path $_.FullName "AppData\Local\Programs\ViewCord"
        }
}

foreach ($entry in $oldEntries) {
    if ($entry.InstallLocation) {
        $foldersToRemove += [string]$entry.InstallLocation
    }
}

$foldersToRemove |
    Where-Object { $_ } |
    Select-Object -Unique |
    ForEach-Object { Remove-ViewCordInstallFolder -Path $_ }

Write-Host "Consultando a última release estável no GitHub..."
$release = Invoke-RestMethod `
    -Uri "https://api.github.com/repos/$repository/releases/latest" `
    -Headers @{
        "User-Agent" = "ViewCord-Installer"
        "Accept" = "application/vnd.github+json"
    }

if (-not $release.assets) {
    throw "A release $($release.tag_name) não contém arquivos para baixar."
}

$setupAssets = @(
    $release.assets |
        Where-Object {
            $_.name -match '(?i)\.exe$' -and
            $_.name -match '(?i)(setup|installer)' -and
            $_.name -match '(?i)x64'
        }
)

if ($setupAssets.Count -eq 0) {
    $setupAssets = @(
        $release.assets |
            Where-Object {
                $_.name -match '(?i)\.exe$' -and
                $_.name -match '(?i)(setup|installer)'
            }
    )
}

if ($setupAssets.Count -eq 0) {
    throw "Não encontrei um instalador setup/installer .exe na release $($release.tag_name)."
}

$asset = $setupAssets | Select-Object -First 1
Write-Host "Versão selecionada: $($release.tag_name)"
Write-Host "Instalador: $($asset.name)"

$installerPath = Join-Path ([IO.Path]::GetFullPath($env:TEMP)) $asset.name

try {
    Write-Host "Baixando o instalador..."
    Invoke-WebRequest `
        -Uri $asset.browser_download_url `
        -OutFile $installerPath

    Write-Host "Instalando silenciosamente..."
    $installProcess = Start-Process `
        -FilePath $installerPath `
        -ArgumentList "/S" `
        -WindowStyle Hidden `
        -Wait `
        -PassThru

    if ($installProcess.ExitCode -ne 0) {
        throw "O instalador terminou com código $($installProcess.ExitCode)."
    }
} finally {
    if (Test-Path -LiteralPath $installerPath) {
        Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
    }
}

Start-Sleep -Seconds 2

$newEntries = @(Get-ViewCordUninstallEntries)
$appPath = Get-ViewCordExecutableCandidates -Entries $newEntries |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1

if (-not $appPath) {
    throw "A instalação terminou, mas não encontrei Viewcord.exe. Confira se o instalador concluiu corretamente."
}

Write-Host "Abrindo o ViewCord $($release.tag_name) na bandeja..."
Start-Process `
    -FilePath $appPath `
    -ArgumentList "--hidden" `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $env:TEMP "viewcord_stdout.log") `
    -RedirectStandardError (Join-Path $env:TEMP "viewcord_stderr.log")

Write-Host "ViewCord $($release.tag_name) instalado e iniciado na bandeja."
