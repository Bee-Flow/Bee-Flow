# Build and optionally push BeeFlow service images with dev/prd tags.
# PowerShell port of scripts/build-images.sh (identical behaviour on Windows).
#
# Usage (from the repo root or anywhere):
#   .\scripts\build-images.ps1 build dev [service...]
#   .\scripts\build-images.ps1 build prd [service...]
#   .\scripts\build-images.ps1 push  dev [service...]
#   .\scripts\build-images.ps1 push  prd [service...]
#
# Build AND update the running containers with the fresh image (-Recreate):
#   .\scripts\build-images.ps1 build dev server agent-hub -Recreate
#   # -Recreate defaults to the COMPOSE_FILE set from the repo .env (the same
#   # files a bare `docker compose up` uses); override with -ComposeFile
#   # (','- or ';'-separated list):
#   .\scripts\build-images.ps1 build dev server -Recreate -ComposeFile docker-compose.from-registry.yml
#
# If your ExecutionPolicy blocks scripts, run it like:
#   powershell -ExecutionPolicy Bypass -File .\scripts\build-images.ps1 build dev
#
# Env (precedence everywhere: explicit flag -> process env -> repo .env -> default):
#   $env:REGISTRY   image namespace; default ghcr.io/bee-flow (matches docker-compose.from-registry.yml).
#   $env:TAG        image tag for `build dev`; default 'dev'.
#   $env:HF_TOKEN   required for reranker build (passed as build secret; also read from .env)
#   $env:LICENSE_SERVER_SRC  Bee Flow-internal only: where the private license-server
#                   source is checked out; default ../Bee-Flow-AI-internal/license-server
#                   (relative paths resolve against the repo root, as in compose).
#   $env:FAST_DEV   set to 1 to skip agent-hub's second (Nextcloud-embed) Vite
#                   build - by far the slowest part of rebuilding that image for
#                   local iteration. The resulting image will NOT serve a working
#                   Nextcloud connector /embed/ shell. Never set this for a `prd`
#                   build or anything you intend to push.

[CmdletBinding()]
param(
    [string]$Action,
    [string]$EnvName,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$ErrorActionPreference = "Stop"

# Parse the trailing args by hand: flags (-Recreate / --recreate, and
# -ComposeFile / --compose-file <path>) plus the positional service filter.
# Manual parsing (instead of extra param() entries) is deliberate: a positional
# [string] parameter would otherwise steal the first service name. CmdletBinding
# + ValueFromRemainingArguments funnels every trailing token (flags included)
# into $Rest, and we sort them out here.
# $ComposeFile stays $null unless the flag is passed — the default is resolved
# from COMPOSE_FILE (env/.env) AFTER Get-EnvOrDotEnv is defined below.
$Recreate = $false
$ComposeFile = $null
$Selected = @()
$Rest = @($Rest)
for ($i = 0; $i -lt $Rest.Count; $i++) {
    $a = $Rest[$i]
    if ($a -match '^--?recreate$') {
        $Recreate = $true
    } elseif ($a -match '^--?compose-?file$') {
        if ($i + 1 -lt $Rest.Count) { $i++; $ComposeFile = $Rest[$i] }
        else { throw "-ComposeFile requires a path argument" }
    } elseif ($a -match '^--?compose-?file=(.+)$') {
        $ComposeFile = $matches[1]
    } else {
        $Selected += $a
    }
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
# Docker/buildx accept forward slashes on Windows; use them for cache + context
# paths so nothing trips over backslash escaping.
$RepoFwd  = $RepoRoot -replace '\\', '/'

# Resolve REGISTRY + TAG from the SAME source the compose stack uses, so the
# images this script builds are exactly the refs docker-compose.from-registry.yml
# pulls/runs: REGISTRY/<svc>:TAG. Precedence: process env var -> repo .env -> default.
$EnvFile = Join-Path $RepoRoot ".env"
function Get-EnvOrDotEnv {
    param([string]$Name, [string]$Default)
    $v = [Environment]::GetEnvironmentVariable($Name)
    if ($v) { return $v }
    if (Test-Path $EnvFile) {
        foreach ($line in Get-Content -LiteralPath $EnvFile) {
            if ($line -match "^\s*$Name\s*=\s*(.*)$") {
                $val = $matches[1].Trim().Trim('"').Trim("'")
                if ($val) { return $val }
            }
        }
    }
    return $Default
}
$Registry = Get-EnvOrDotEnv "REGISTRY" "ghcr.io/bee-flow"
$Tag      = Get-EnvOrDotEnv "TAG" "dev"

# -ComposeFile default follows the canonical set the stack itself uses
# (COMPOSE_FILE in env/.env, ';'- or ','-separated), so a script recreate can
# never drift from what a bare `docker compose up` produces.
if (-not $ComposeFile) {
    $ComposeFile = Get-EnvOrDotEnv "COMPOSE_FILE" "docker-compose.from-registry.yml"
}

# HF_TOKEN from .env (reranker build secret) unless already in the process env.
$hf = Get-EnvOrDotEnv "HF_TOKEN" ""
if ($hf -and -not $env:HF_TOKEN) { $env:HF_TOKEN = $hf }

# license-server (the module hub) is Bee Flow-internal: its source lives in the
# private Bee-Flow-AI-internal repository, not in this one. It is built from a
# checkout of that repository next to this one, the same path
# docker-compose.dev.yml and docker-compose.hub.local.yml build from. Without
# that checkout a bulk build skips it; naming it is an error (see Build-One).
$LicenseServerSrc = Get-EnvOrDotEnv "LICENSE_SERVER_SRC" "../Bee-Flow-AI-internal/license-server"

# service | context | dockerfile (relative to context, empty = Dockerfile)
# A relative context resolves against the repo root.
# NOTE: GPU images (search-inference-gpu, whisperx) are deliberately NOT built
# here — this box has no GPU and their CUDA bases are huge. CI still builds
# them for GPU deployments (.github/workflows/build-push-ghcr.yml).
$Services = @(
    [pscustomobject]@{ Name = "server";               Context = "server";          Dockerfile = "" }
    [pscustomobject]@{ Name = "agent-hub";            Context = "agent-hub";       Dockerfile = "" }
    [pscustomobject]@{ Name = "search-api";           Context = "search-service";  Dockerfile = "Dockerfile" }
    [pscustomobject]@{ Name = "guard";                Context = "guard-service";   Dockerfile = "" }
    [pscustomobject]@{ Name = "pii";                  Context = "pii-service";     Dockerfile = "" }
    [pscustomobject]@{ Name = "install-wizard";       Context = "install-wizard";  Dockerfile = "" }
    [pscustomobject]@{ Name = "reranker";             Context = "reranker";        Dockerfile = "" }
    [pscustomobject]@{ Name = "license-server";       Context = $LicenseServerSrc; Dockerfile = "" }
    # Headless-Chromium runner. NOT a compose service — the server spawns it via
    # the docker socket as the shared `bf-browser` container that backs the
    # `browse_web` chat/agent tool (plus PDF export, thumbnails, SPA ingestion).
    # Building it locally is what makes browse_web work without the private
    # ghcr.io/bee-flow/pwt-runner image; see the pwt-runner tag note in Build-One.
    [pscustomobject]@{ Name = "pwt-runner";           Context = "server/pwt-runner"; Dockerfile = "" }
)

# classify: CPU image, built only by CI (build-push-ghcr.yml). Not a GPU image;
# it is left out because its model is baked in at build time and that build
# happens in one place only. `build dev` and `build dev classify` say so and
# skip it; run it from ghcr.io/bee-flow/classify:<tag> instead.
$CiOnlyServices = @("classify")

$BuilderName = "beeflow"

# ---------- helpers ----------

function Show-Usage {
    Write-Host "Usage:" -ForegroundColor Yellow
    Write-Host "  .\scripts\build-images.ps1 build dev [service...]"
    Write-Host "  .\scripts\build-images.ps1 build prd [service...]"
    Write-Host "  .\scripts\build-images.ps1 push  dev [service...]"
    Write-Host "  .\scripts\build-images.ps1 push  prd [service...]"
    exit 1
}

# Run docker, stream its output, and throw on a non-zero exit (mirrors set -e).
function Invoke-Docker {
    param([string[]]$DockerArgs)
    & docker @DockerArgs
    if ($LASTEXITCODE -ne 0) {
        throw "docker $($DockerArgs -join ' ') failed (exit $LASTEXITCODE)"
    }
}

# Run docker silently and return $true only if it exited 0 (for probes).
function Test-DockerQuiet {
    param([string[]]$DockerArgs)
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & docker @DockerArgs *> $null
        return ($LASTEXITCODE -eq 0)
    } finally {
        $ErrorActionPreference = $old
    }
}

# Playwright version the server pins (server/package.json). The server derives
# its local runner-image tag from the *installed* playwright version
# (services/pwtRunner.js: `beeflow-pwt-runner:pw-<version>`), which equals this
# pinned version. We tag the pwt-runner build with the exact same ref so the
# server auto-detects it (imageExists short-circuits before any registry pull).
function Get-PlaywrightVersion {
    $pkg = Join-Path $RepoRoot "server/package.json"
    if (Test-Path $pkg) {
        foreach ($line in Get-Content -LiteralPath $pkg) {
            if ($line -match '"playwright"\s*:\s*"([^"]+)"') { return $matches[1].Trim() }
        }
    }
    throw "Could not read the playwright version from server/package.json (needed to tag pwt-runner)."
}

# HEAD sha for VITE_BUILD_SHA; "local" when git is unavailable / not a repo.
function Get-GitSha {
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $sha = & git -C $RepoRoot rev-parse HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and $sha) {
            return ($sha | Select-Object -First 1).ToString().Trim()
        }
    } catch { }
    finally { $ErrorActionPreference = $old }
    return "local"
}

# Which builder Build-One uses, decided once by Confirm-Builder below.
# Empty $BuilderArgs = the current (default) builder.
$script:BuilderArgs = @()
$script:LoadArgs    = @()

# Builder choice, fastest-first:
#
#  1. The `docker` driver (Docker Desktop's default builder) writes the result
#     STRAIGHT into the daemon's image store. Nothing to load afterwards.
#  2. A dedicated `docker-container` builder needs `--load`, which serialises the
#     whole image out to an OCI tarball and back in again — measured at ~60s of
#     the server image's ~70s rebuild on this box, i.e. almost all of it.
#
# The historical reason for (2) was cache durability: the docker driver's
# BuildKit cache is wiped by `docker builder prune` / `docker system prune` /
# engine restart. That is already covered by the per-service local cache dir in
# Build-One — after a wipe the first build re-imports it (measured: a pruned
# server build reseeds from .buildx-cache and still finishes in ~12s), so the
# tarball hop buys nothing.
#
# Set $env:BEEFLOW_FORCE_CONTAINER_BUILDER=1 to force the old behaviour.
function Confirm-Builder {
    if ($env:BEEFLOW_FORCE_CONTAINER_BUILDER -ne "1") {
        $driver = ""
        $old = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            foreach ($line in (& docker buildx inspect 2>$null)) {
                if ($line -match '^\s*Driver:\s*(\S+)') { $driver = $matches[1]; break }
            }
        } catch { } finally { $ErrorActionPreference = $old }

        if ($driver -eq "docker") {
            # Default builder, no --load: buildx hands the image to the daemon directly.
            $script:BuilderArgs = @()
            $script:LoadArgs    = @()
            return
        }
    }

    if (-not (Test-DockerQuiet @("buildx", "inspect", $BuilderName))) {
        Write-Host "==> creating persistent buildx builder '$BuilderName' (docker-container) ..."
        Invoke-Docker @("buildx", "create", "--name", $BuilderName, "--driver", "docker-container", "--bootstrap")
    }
    $script:BuilderArgs = @("--builder", $BuilderName)
    $script:LoadArgs    = @("--load")
}

function Get-TagsFor {
    param([string]$Svc, [string]$Env)
    if ($Env -eq "dev") {
        return @("$Registry/$Svc`:$Tag")
    } else {
        return @("$Registry/$Svc`:latest", "$Registry/$Svc`:prod")
    }
}

# Sets $script:BuildSkipped when it deliberately built nothing, so the caller
# does not record that service as built (-Recreate and its image verification
# act on that list). A real failure still throws.
$script:BuildSkipped = $false
function Build-One {
    param([pscustomobject]$Service, [string]$Env)

    $script:BuildSkipped = $false
    $svc        = $Service.Name
    $context    = $Service.Context
    $dockerfile = $Service.Dockerfile
    # A relative context resolves against the repo root (license-server's
    # may point outside it, at the private checkout).
    if ([System.IO.Path]::IsPathRooted($context)) { $ctxDir = $context -replace '\\', '/' }
    else { $ctxDir = "$RepoFwd/$context" }

    $tagArgs = @()
    foreach ($t in (Get-TagsFor $svc $Env)) { $tagArgs += @("-t", $t) }

    # pwt-runner also carries the EXACT local ref the server auto-detects
    # (services/pwtRunner.js LOCAL_IMAGE_TAG = beeflow-pwt-runner:pw-<playwright ver>).
    # With this tag present, a plain `build dev pwt-runner` is all that's needed to
    # make browse_web work: the server finds this image on the shared docker daemon
    # and never tries to pull the private ghcr runner or build one in-container.
    # Added here (not in Get-TagsFor) so it's a build-only tag — `push` stays
    # registry-only and never attempts to push this un-prefixed local ref.
    if ($svc -eq "pwt-runner") {
        $tagArgs += @("-t", "beeflow-pwt-runner:pw-$(Get-PlaywrightVersion)")
    }

    $extra = @()
    switch ($svc) {
        "server" {
            # DB-IP Lite edition month for the Dockerfile's `geo` stage (cache key).
            $extra += @("--build-arg", "GEO_DB_MONTH=$((Get-Date).ToUniversalTime().ToString('yyyy-MM'))")
        }
        "agent-hub" {
            $extra += @("--build-arg", "VITE_BUILD_SHA=$(Get-GitSha)")
            $extra += @("--build-arg", "BUILDKIT_INLINE_CACHE=1")
            if ($env:FAST_DEV -eq "1") { $extra += @("--build-arg", "BUILD_EMBED=false") }
        }
        "reranker" {
            if (-not $env:HF_TOKEN) {
                # Explicitly asked for reranker → hard error. Part of a broader
                # build (e.g. `build dev` with no service filter) → skip it with a
                # warning instead of aborting every remaining service.
                if ($Selected -and ($Selected -contains "reranker")) {
                    throw "HF_TOKEN must be set to build reranker"
                }
                Write-Host "==> Skipping reranker - HF_TOKEN not set (set `$env:HF_TOKEN to include it)." -ForegroundColor Yellow
                $script:BuildSkipped = $true
                return
            }
            # docker reads the value straight from this process's environment.
            $extra += @("--secret", "id=HF_TOKEN,env=HF_TOKEN")
        }
        "license-server" {
            # Private source, checked out beside this repo (see $LicenseServerSrc
            # above). Same rule as the reranker: named → hard error, bulk → skip.
            if (-not (Test-Path -LiteralPath "$ctxDir/Dockerfile")) {
                if ($Selected -and ($Selected -contains "license-server")) {
                    throw "license-server is Bee Flow-internal and its source is not in this repository - no checkout at $ctxDir. Check out Bee-Flow-AI-internal next to this repo, or set `$env:LICENSE_SERVER_SRC."
                }
                Write-Host "==> Skipping license-server - its private source is not checked out at $ctxDir (set `$env:LICENSE_SERVER_SRC to include it)." -ForegroundColor Yellow
                $script:BuildSkipped = $true
                return
            }
        }
    }

    $fileArg = @()
    if ($dockerfile) { $fileArg = @("-f", "$ctxDir/$dockerfile") }

    $cacheDir = "$RepoFwd/.buildx-cache/$svc"

    Write-Host "==> Building $svc ($Env) ..." -ForegroundColor Cyan
    $dockerArgs = @("buildx", "build") + $script:BuilderArgs + $script:LoadArgs + @(
        "--cache-from", "type=local,src=$cacheDir",
        "--cache-to",   "type=local,dest=$cacheDir,mode=max")
    $dockerArgs += $fileArg
    $dockerArgs += $tagArgs
    $dockerArgs += $extra
    $dockerArgs += $ctxDir

    Invoke-Docker $dockerArgs
}

function Push-One {
    param([string]$Svc, [string]$Env)
    foreach ($t in (Get-TagsFor $svc $Env)) {
        Write-Host "==> Pushing $t" -ForegroundColor Cyan
        Invoke-Docker @("push", $t)
    }
}

function Confirm-Login {
    # Heuristic: ghcr.io login leaves an auth entry in ~/.docker/config.json.
    if ($Registry -like "ghcr.io/*") {
        $configPath = Join-Path $HOME ".docker/config.json"
        $loggedIn = $false
        if (Test-Path $configPath) {
            if ((Get-Content -Raw $configPath) -match "ghcr\.io") { $loggedIn = $true }
        }
        if (-not $loggedIn) {
            throw "not logged into ghcr.io. Run: docker login ghcr.io"
        }
    }
}

# A handful of build-image names differ from their docker-compose service name.
$ComposeServiceMap = @{
    "guard" = "guard-service"
    "pii"   = "pii-service"
}

# The guarantee: after a recreate, every container MUST be running the exact
# image this run produced. Compose resolving a stale tag, a container that
# failed to come back up, an image ref drifting between build and recreate — all
# of them look like "I rebuilt and my changes are not there", and all of them are
# silent. Comparing the container's image ID to the built image's ID catches
# every one of them, so the script can never exit 0 on a stale container.
# First stdout line of a docker command, or "" when it produced none. Never
# throws and never consults $LASTEXITCODE — callers treat "" as the failure.
function Get-FirstLine {
    param([string[]]$DockerArgs)
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = @(& docker @DockerArgs 2>$null)
        if ($out.Count -gt 0) { return "$($out[0])".Trim() }
        return ""
    } catch { return "" } finally { $ErrorActionPreference = $old }
}

function Assert-RunningImage {
    param([string[]]$ComposeBase, [string[]]$Targets, [string[]]$BuiltNames)

    # compose service name -> the build-image name it was built under
    $reverse = @{}
    foreach ($b in $BuiltNames) {
        $c = if ($ComposeServiceMap.ContainsKey($b)) { $ComposeServiceMap[$b] } else { $b }
        $reverse[$c] = $b
    }

    foreach ($t in $Targets) {
        # @() because a single-tag (dev) result comes back unwrapped as a plain
        # string, and [0] on a string yields its first CHARACTER — which is how
        # this once failed with "just-built image 'g' is missing", 'g' being the
        # front of ghcr.io. Bind the array first and cast the element: an
        # inline @(...)[0] is too easy to reintroduce, and the symptom looks
        # like a docker problem rather than a string-indexing one. A ref this
        # short can only be that bug, so say so instead of asking docker.
        $refTags = @(Get-TagsFor $reverse[$t] $EnvName)
        $ref = if ($refTags.Count -gt 0) { [string]$refTags[0] } else { "" }
        if ($ref.Length -lt 3) {
            throw "internal: could not resolve the image tag for '$t' (got '$ref'). This is a script bug, not a build failure."
        }

        # Collect into an array and index it instead of piping to
        # `Select-Object -First 1`: -First stops the pipeline as soon as it has
        # its line, which kills the docker process early and leaves a bogus
        # $LASTEXITCODE behind. Emptiness is the reliable signal here.
        $wanted  = Get-FirstLine @("image", "inspect", $ref, "--format", "{{.Id}}")
        if (-not $wanted) { throw "just-built image '$ref' is missing from the daemon - cannot verify $t." }

        $cid = Get-FirstLine ($ComposeBase + @("ps", "-q", $t))
        if (-not $cid) { throw "service '$t' has no running container after --force-recreate." }

        $running = Get-FirstLine @("inspect", $cid, "--format", "{{.Image}}")
        if ($running -ne $wanted) {
            throw "STALE CONTAINER: '$t' is running image $running but this build produced $wanted ($ref). Your changes are NOT in the running container."
        }
        Write-Host "==> verified: $t is running $ref ($($wanted -replace '^sha256:(.{12}).*$', '$1'))" -ForegroundColor Green
    }
}

# Recreate the containers for the just-built services so they pick up the fresh
# image. `docker compose up -d` alone can leave a container on its old image;
# --force-recreate guarantees the swap, and Assert-RunningImage proves it.
function Update-Containers {
    param([string[]]$BuiltNames)

    # -ComposeFile accepts a ','- or ';'-separated list for stacks assembled
    # from a base file + overrides (';' matches the COMPOSE_FILE syntax in .env,
    # e.g. "docker-compose.from-registry.yml;docker-compose.hub.local.yml").
    $fileArgs = @()
    foreach ($f in ($ComposeFile -split '[;,]')) {
        $f = $f.Trim()
        if (-not $f) { continue }
        $p = if ([System.IO.Path]::IsPathRooted($f)) { $f } else { Join-Path $RepoRoot $f }
        if (-not (Test-Path $p)) {
            # HARD failure, never a warning: a skipped recreate leaves the old
            # container running on the old image while the build reported
            # success — indistinguishable from "my changes did not take".
            throw "Compose file not found: $p - refusing to report success without recreating."
        }
        $fileArgs += @("-f", $p)
    }

    # Shared compose flags. --project-directory + --env-file pin the SAME project
    # name and .env as your running stack (so this updates it in place, not a
    # duplicate project) regardless of the current working directory.
    $composeBase = @("compose", "--project-directory", $RepoRoot) + $fileArgs
    if (Test-Path $EnvFile) { $composeBase += @("--env-file", $EnvFile) }

    # Hand compose the EXACT registry/tag this run just built, so the recreate
    # can't drift onto a different image ref (compose files here default TAG to
    # 'latest' when unset — recreating with a stale :latest instead of the fresh
    # build). Process-scoped env vars override the .env inside docker compose.
    $env:REGISTRY = $Registry
    $env:TAG = $Tag

    # docker compose warns on stderr (e.g. an unset optional ${HF_TOKEN}); under
    # PS 5.1's $ErrorActionPreference='Stop' that native stderr would throw. Drop
    # to 'Continue' around the compose calls and gate on $LASTEXITCODE instead.
    $old = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        # Services in the ACTIVE profile set only (COMPOSE_PROFILES from .env, or
        # profile-less files like docker-compose.dev.yml). Deliberately NOT
        # --profile '*': a bulk `build dev -Recreate` must never force-start
        # profile-gated services (GPU, search, ...) the stack doesn't run.
        $composeServices = @(& docker @composeBase config --services 2>$null)
        if ($LASTEXITCODE -ne 0 -or -not $composeServices) {
            throw "Could not list services in $ComposeFile - refusing to report success without recreating."
        }

        $targets = @()
        foreach ($b in $BuiltNames) {
            $c = if ($ComposeServiceMap.ContainsKey($b)) { $ComposeServiceMap[$b] } else { $b }
            if ($composeServices -contains $c) { $targets += $c }
            elseif ($Selected -contains $b) {
                # Explicitly asked for on the command line, so it MUST land. Only a
                # bulk build (no service filter) may quietly pass over the images
                # that are not compose services at all (pwt-runner, install-wizard).
                throw "'$b' was built but is not a service in the active stack ($ComposeFile) - it cannot be recreated, so the running containers would NOT have your changes."
            }
            else { Write-Host "==> '$b' is not in the active stack ($ComposeFile) - not recreating it." -ForegroundColor Yellow }
        }
        if ($targets.Count -eq 0) {
            Write-Host "==> No built services map to $ComposeFile - nothing to recreate." -ForegroundColor Yellow
            return
        }

        Write-Host "==> Recreating from ${ComposeFile}: $($targets -join ', ')" -ForegroundColor Cyan
        # Naming services explicitly starts them even if they sit behind a profile.
        & docker @composeBase up -d --force-recreate @targets
        if ($LASTEXITCODE -ne 0) { throw "docker compose up -d --force-recreate failed (exit $LASTEXITCODE)" }

        Assert-RunningImage -ComposeBase $composeBase -Targets $targets -BuiltNames $BuiltNames
    } finally {
        $ErrorActionPreference = $old
    }
}

# ---------- main ----------

if (-not $Action -or -not $EnvName) { Show-Usage }
if ($Action  -notin @("build", "push")) { Show-Usage }
if ($EnvName -notin @("dev", "prd"))     { Show-Usage }

if ($Action -eq "push")  { Confirm-Login }
if ($Action -eq "build") { Confirm-Builder }

foreach ($ciSvc in $CiOnlyServices) {
    if (-not $Selected -or $Selected.Count -eq 0 -or ($Selected -contains $ciSvc)) {
        Write-Host "==> Skipping $ciSvc - CPU image built only by CI (.github/workflows/build-push-ghcr.yml); pull $Registry/${ciSvc}:$Tag instead." -ForegroundColor Yellow
    }
}

$built = @()
foreach ($service in $Services) {
    if ($Selected -and $Selected.Count -gt 0 -and ($service.Name -notin $Selected)) {
        continue
    }
    switch ($Action) {
        "build" {
            Build-One $service $EnvName
            # Only a real build is recorded: a skipped service produced no image.
            if (-not $script:BuildSkipped) { $built += $service.Name }
        }
        "push"  { Push-One  $service.Name $EnvName }
    }
}

if ($Recreate) {
    if ($Action -ne "build") {
        Write-Host "==> -Recreate only applies to 'build' - ignoring." -ForegroundColor Yellow
    } elseif ($built.Count -eq 0) {
        Write-Host "==> Nothing was built - nothing to recreate." -ForegroundColor Yellow
    } else {
        Update-Containers -BuiltNames $built
    }
}
