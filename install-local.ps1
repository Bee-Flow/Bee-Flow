# Bee Flow AI - one-time local install (Windows / PowerShell)
#
# Sets up the *core services only* (frontend + backend + a PostgreSQL container)
# for local laptop/desktop development. Run this once. After it finishes, start
# the stack with `npm run dev:all`.
#
# Usage (from this folder):
#   powershell -ExecutionPolicy Bypass -File .\install-local.ps1

#Requires -Version 5.1

$ErrorActionPreference = "Stop"
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile     = Join-Path $ScriptRoot ".env"
$EnvExample  = Join-Path $ScriptRoot ".env.example"

# Non-standard ports to avoid colliding with other Postgres / dev servers on the host.
$PgContainer    = "beeflow-postgres"
$PgImage        = "pgvector/pgvector:pg15"
$PgUser         = "beeflow"
$PgPassword     = "beeflow"
$PgDb           = "beeflow_core"      # primary DB the server reads via CORE_DATABASE_URL
$PgDbTasks      = "beeflow_tasks"     # secondary DB read via DATABASE_URL
$PgDbMonitoring = "monitoring_db"
$PgPort      = "55432"      # host port -> container's 5432
$ServerPort  = "3101"       # backend
$ClientPort  = "5276"       # frontend (Vite)


# ---------- helpers ----------

function Write-Step($msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok  ($msg) { Write-Host "    OK   $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    !!   $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "    FAIL $msg" -ForegroundColor Red; exit 1 }

function Test-Cmd($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Invoke-Cmd {
    param([string]$File, [string[]]$Arguments, [string]$Cwd = $ScriptRoot)
    Write-Host "    $ $File $($Arguments -join ' ')"
    Push-Location $Cwd
    try {
        & $File @Arguments
        if ($LASTEXITCODE -ne 0) { throw "$File exited with code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

function Get-DockerOutput([string[]]$Args) {
    $out = & docker @Args 2>$null
    if ($null -eq $out) { return "" }
    return ($out | Out-String).Trim()
}


# ---------- steps ----------

function Check-Prerequisites {
    Write-Step "Checking prerequisites"

    if (-not (Test-Cmd "node")) {
        Write-Fail "Node.js is not installed. Install Node.js 20+ from https://nodejs.org/"
    }
    Write-Ok ("node " + (& node --version))

    if (-not (Test-Cmd "npm")) {
        Write-Fail "npm is not installed. It ships with Node.js."
    }
    # npm.cmd on Windows; calling 'npm --version' works either way
    Write-Ok ("npm " + (& npm --version))

    if (-not (Test-Cmd "docker")) {
        Write-Warn "Docker not found - you will need to install PostgreSQL with pgvector manually."
        Write-Warn "Install Docker Desktop from https://www.docker.com/products/docker-desktop/ and re-run this script."
    } else {
        Write-Ok ((& docker --version))
    }
}

function Install-NpmDependencies {
    Write-Step "Installing npm dependencies (root, server, agent-hub)"
    Invoke-Cmd -File "npm.cmd" -Arguments @("install") -Cwd $ScriptRoot
    Invoke-Cmd -File "npm.cmd" -Arguments @("install") -Cwd (Join-Path $ScriptRoot "server")
    Invoke-Cmd -File "npm.cmd" -Arguments @("install") -Cwd (Join-Path $ScriptRoot "agent-hub")
    Write-Ok "dependencies installed"
}

function Start-Postgres {
    Write-Step "Starting PostgreSQL (pgvector) container"

    if (-not (Test-Cmd "docker")) {
        Write-Warn "Skipping - Docker not available. Make sure PostgreSQL 15+ with pgvector is"
        Write-Warn "running on localhost:$PgPort with database '$PgDb' (user '$PgUser')."
        return
    }

    $existing = Get-DockerOutput @("ps", "-a", "--filter", "name=^$PgContainer$", "--format", "{{.Names}}")
    if ($existing -eq $PgContainer) {
        $running = Get-DockerOutput @("ps", "--filter", "name=^$PgContainer$", "--format", "{{.Names}}")
        if ($running -eq $PgContainer) {
            Write-Ok "container '$PgContainer' already running"
            return
        }
        # Stopped container exists. Its port mapping may be stale (e.g. from an
        # earlier install that used a different port). Remove and recreate.
        Write-Warn "removing stopped container '$PgContainer' to recreate with current port mapping"
        Invoke-Cmd -File "docker" -Arguments @("rm", "-f", $PgContainer)
    }

    $InitScript = Join-Path $ScriptRoot "docker/init-db.sh"
    if (-not (Test-Path $InitScript)) {
        Write-Fail "missing $InitScript - needed to create $PgDbTasks/$PgDbMonitoring and enable pgvector"
    }
    # Docker on Windows accepts forward slashes for the host path of -v mounts.
    $InitMount = ($InitScript -replace '\\', '/') + ":/docker-entrypoint-initdb.d/init-db.sh:ro"

    Invoke-Cmd -File "docker" -Arguments @(
        "run", "-d",
        "--name", $PgContainer,
        "-e", "POSTGRES_USER=$PgUser",
        "-e", "POSTGRES_PASSWORD=$PgPassword",
        "-e", "POSTGRES_DB=$PgDb",
        "-p", "$($PgPort):5432",
        "-v", $InitMount,
        $PgImage
    )
    Write-Ok "container '$PgContainer' created (DBs: $PgDb, $PgDbTasks, $PgDbMonitoring)"
}

function Wait-Postgres {
    param([int]$TimeoutSeconds = 60)
    Write-Step "Waiting for PostgreSQL to be ready"
    if (-not (Test-Cmd "docker")) {
        Write-Warn "Skipping wait - Docker not available"
        return
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        & docker exec $PgContainer pg_isready -U $PgUser -d $PgDb 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "PostgreSQL is accepting connections"
            return
        }
        Start-Sleep -Seconds 1
    }
    Write-Fail "PostgreSQL did not become ready within $TimeoutSeconds`s"
}

function New-EnvFile {
    Write-Step "Configuring .env"

    if (Test-Path $EnvFile) {
        Write-Ok ".env already exists - leaving it untouched"
        return
    }

    if (-not (Test-Path $EnvExample)) {
        Write-Fail ".env.example is missing; cannot generate .env"
    }

    # Generate a 64-char hex SESSION_SECRET
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $sessionSecret = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""

    $contents = Get-Content -Raw $EnvExample
    $contents = $contents.Replace(
        "SESSION_SECRET=your-super-secure-session-secret-change-me",
        "SESSION_SECRET=$sessionSecret"
    )
    $contents = $contents.Replace(
        "VITE_API_URL=",
        "VITE_API_URL=http://localhost:$ServerPort"
    )
    $DbBase = "postgresql://$PgUser`:$PgPassword@localhost:$PgPort"
    $contents = $contents.Replace(
        "DATABASE_URL=postgresql://beeflow:beeflow@localhost:5432/beeflow_tasks",
        "DATABASE_URL=$DbBase/$PgDbTasks"
    )
    $contents = $contents.Replace("SERVER_PORT=3001", "SERVER_PORT=$ServerPort")
    $contents = $contents.Replace("CLIENT_PORT=5176", "CLIENT_PORT=$ClientPort")

    # The server reads CORE_DATABASE_URL (main DB) and MONITORING_DATABASE_URL,
    # but .env.example only ships DATABASE_URL. Append the missing two.
    $extras = "`n# --- Added by install-local.ps1 ---`n" +
              "CORE_DATABASE_URL=$DbBase/$PgDb`n" +
              "MONITORING_DATABASE_URL=$DbBase/$PgDbMonitoring`n"
    $contents = $contents.TrimEnd() + "`n" + $extras

    Set-Content -Path $EnvFile -Value $contents -NoNewline
    Write-Ok ".env created with a freshly generated SESSION_SECRET"
}

function Invoke-Migrations {
    Write-Step "Running database migrations"
    try {
        Invoke-Cmd -File "npm.cmd" -Arguments @("run", "db:migrate") -Cwd (Join-Path $ScriptRoot "server")
        Write-Ok "migrations complete"
    } catch {
        Write-Warn "migrations failed - Postgres may still be starting. Re-run later with:"
        Write-Warn "    cd server; npm run db:migrate"
    }
}

function Show-NextSteps {
    Write-Host ""
    Write-Host "Install complete!" -ForegroundColor Green
    Write-Host ""
    Write-Host "To start Bee Flow AI next time, run from this folder:" -ForegroundColor White
    Write-Host ""
    Write-Host "    npm run dev:all" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Or in two terminals:"
    Write-Host "    npm run dev:server     # backend  -> http://localhost:$ServerPort" -ForegroundColor Cyan
    Write-Host "    npm run dev:frontend   # frontend -> http://localhost:$ClientPort" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "PostgreSQL runs in Docker as '$PgContainer' on host port $PgPort. Manage it with:"
    Write-Host "    docker start $PgContainer    # start the database" -ForegroundColor Cyan
    Write-Host "    docker stop  $PgContainer    # stop it when you're done" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Open the Agent Hub at: http://localhost:$ClientPort"
    Write-Host ""
}


# ---------- main ----------

Write-Host "Bee Flow AI - local install (core services)" -ForegroundColor White

try {
    Check-Prerequisites
    Install-NpmDependencies
    Start-Postgres
    New-EnvFile
    Wait-Postgres
    Invoke-Migrations
    Show-NextSteps
} catch {
    Write-Host ""
    Write-Host "Install failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
