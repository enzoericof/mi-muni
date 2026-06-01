$ErrorActionPreference = "Stop"

$launchedFromExplorer = $false
try {
  $currentProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
  if ($currentProcess) {
    $parentProcess = Get-Process -Id $currentProcess.ParentProcessId -ErrorAction SilentlyContinue
    $launchedFromExplorer = $parentProcess -and $parentProcess.ProcessName -ieq "explorer"
  }
} catch {
  $launchedFromExplorer = $false
}

if ($launchedFromExplorer -and $env:MI_MUNI_START_HOSTED -ne "1") {
  $selfPath = $MyInvocation.MyCommand.Path
  $escapedPath = $selfPath.Replace("'", "''")
  $command = "& { `$env:MI_MUNI_START_HOSTED='1'; & '$escapedPath' }"
  Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", $command
  exit 0
}

$keepWindowOpen = $launchedFromExplorer -or $env:MI_MUNI_START_HOSTED -eq "1"

function Wait-BeforeClose {
  if ($keepWindowOpen) {
    Write-Host ""
    Read-Host "Presiona Enter para cerrar"
  }
}

function Invoke-Compose {
  param(
    [string[]]$Arguments
  )

  & docker compose @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Fallo Docker Compose."
  }
}

function Test-HttpReady {
  param(
    [string]$Url
  )

  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 4
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Get-ServiceState {
  param(
    [string]$Service
  )

  $state = (& docker compose ps --status running --services 2>$null) | Where-Object { $_ -eq $Service }
  if ($state) {
    return "running"
  }

  $allServices = & docker compose ps -a --format json 2>$null
  if (-not $allServices) {
    return ""
  }

  foreach ($line in $allServices) {
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }
    $item = $line | ConvertFrom-Json
    if ($item.Service -eq $Service) {
      return [string]$item.State
    }
  }

  return ""
}

function Get-ServiceLogs {
  param(
    [string]$Service,
    [int]$Tail = 40
  )

  $logs = & docker compose logs --no-color --tail=$Tail $Service 2>$null
  if (-not $logs) {
    return @()
  }
  return @($logs)
}

function Get-LastUsefulLine {
  param(
    [string[]]$Lines
  )

  $filtered = $Lines | Where-Object {
    $_ -and
    $_.Trim() -ne "" -and
    $_ -notmatch '^\s*> ' -and
    $_ -notmatch '^\s*npm ' -and
    $_ -notmatch '^\s*at ' -and
    $_ -notmatch '^\s*Node\.js v'
  }

  if ($filtered.Count -gt 0) {
    return $filtered[-1]
  }

  if ($Lines.Count -gt 0) {
    return $Lines[-1]
  }

  return ""
}

try {
  $repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
  Set-Location $repoRoot

  $dockerComposeFile = Join-Path $repoRoot "docker-compose.yml"
  $envFile = Join-Path $repoRoot ".env.local"
  $envSource = Join-Path $repoRoot ".env"
  $envExample = Join-Path $repoRoot ".env.local.example"

  if (-not (Test-Path $dockerComposeFile)) {
    throw "No se encontro docker-compose.yml en $repoRoot"
  }

  if (-not (Test-Path $envFile) -and (Test-Path $envSource)) {
    Copy-Item -LiteralPath $envSource -Destination $envFile
    Write-Host "Se copio .env a .env.local."
  } elseif (-not (Test-Path $envFile) -and (Test-Path $envExample)) {
    Copy-Item -LiteralPath $envExample -Destination $envFile
    Write-Host "Se creo .env.local desde .env.local.example."
  } else {
    Write-Host "Usando .env.local existente."
  }

  $databaseUrlLine = if (Test-Path $envFile) {
    Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
  } else {
    $null
  }
  $databaseUrl = if ($databaseUrlLine) {
    ($databaseUrlLine -replace '^DATABASE_URL=', '').Trim()
  } else {
    ''
  }
  $useExternalDatabase = -not [string]::IsNullOrWhiteSpace($databaseUrl)

  & (Join-Path $PSScriptRoot "stop-project.ps1")

  Write-Host "Iniciando Mi Muni..."
  if ($useExternalDatabase) {
    Write-Host "Modo: base de datos externa"
    Invoke-Compose -Arguments @("up", "--build", "-d", "--no-deps", "backend", "worker", "frontend")
  } else {
    Write-Host "Modo: PostgreSQL local"
    Invoke-Compose -Arguments @("up", "--build", "-d")
    Write-Host "base de datos: iniciando"
  }

  Write-Host "backend: iniciando"
  Write-Host "modulo municipal: iniciando"
  Write-Host "frontend: iniciando"

  $dbReady = $useExternalDatabase
  $backendDbReady = $false
  $authReady = $false
  $backendReady = $false
  $workerReady = $false
  $frontendReady = $false

  $deadline = (Get-Date).AddSeconds(90)
  do {
    if (-not $dbReady -and (Get-ServiceState -Service "postgres") -eq "running") {
      Write-Host "base de datos: lista"
      $dbReady = $true
    }

    $backendLogs = Get-ServiceLogs -Service "backend"
    $workerLogs = Get-ServiceLogs -Service "worker"
    $frontendLogs = Get-ServiceLogs -Service "frontend"

    if (-not $backendDbReady -and ($backendLogs -match 'Connected to PostgreSQL')) {
      Write-Host "backend: base de datos lista"
      $backendDbReady = $true
    }

    if (-not $authReady -and ($backendLogs -match 'Synced .* seeded users' -or $backendLogs -match 'Collection backend ya cargado')) {
      Write-Host "backend: auth listo"
      $authReady = $true
    }

    if (-not $workerReady -and ($workerLogs -match 'Mi Muni listo en 0.0.0.0:8790' -or $workerLogs -match 'listening on 0.0.0.0:8790')) {
      Write-Host "modulo municipal: listo"
      $workerReady = $true
    }

    if (-not $backendReady -and (Test-HttpReady -Url "http://127.0.0.1:8787/api/health")) {
      Write-Host "backend: listo"
      $backendReady = $true
    }

    if (-not $frontendReady -and (Test-HttpReady -Url "http://127.0.0.1:4173")) {
      Write-Host "frontend: listo"
      $frontendReady = $true
    }

    $backendState = Get-ServiceState -Service "backend"
    if (-not $backendReady -and $backendState -eq "exited") {
      $line = Get-LastUsefulLine -Lines $backendLogs
      throw ("backend: " + $(if ($line) { $line } else { "fallo al iniciar" }))
    }

    $workerState = Get-ServiceState -Service "worker"
    if (-not $workerReady -and $workerState -eq "exited") {
      $line = Get-LastUsefulLine -Lines $workerLogs
      throw ("modulo municipal: " + $(if ($line) { $line } else { "fallo al iniciar" }))
    }

    $frontendState = Get-ServiceState -Service "frontend"
    if (-not $frontendReady -and $frontendState -eq "exited") {
      $line = Get-LastUsefulLine -Lines $frontendLogs
      throw ("frontend: " + $(if ($line) { $line } else { "fallo al iniciar" }))
    }

    if ($backendReady -and $frontendReady) {
      break
    }

    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)

  Write-Host ""
  Write-Host "App: http://127.0.0.1:4173"
  Write-Host "API: http://127.0.0.1:8787/api/health"
  Write-Host ""
  Write-Host "Logs:"
  Write-Host "docker compose logs -f --tail=60 backend worker frontend"
} catch {
  Write-Host ""
  Write-Host ("ERROR: " + $_.Exception.Message) -ForegroundColor Red
  Write-Host "Para ver mas detalle:" -ForegroundColor Red
  Write-Host "docker compose logs --tail=80 backend worker frontend" -ForegroundColor Red
}

Wait-BeforeClose
