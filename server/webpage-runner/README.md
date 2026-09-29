# Webpage full-tier runtime (`webpage-runner`)

A per-project Node.js dev container: a real **Vite** dev server (+ optional Node
backend) per actively-edited "full" webpage project. Gives native npm, ES
modules, JSX/TSX and Material UI — the preview iframe points at the container
through a reverse proxy instead of inlining a `srcdoc`.

> **STATUS: GATED + INERT.** Nothing here runs in production until ops sets
> `WEBPAGE_FULL_RUNTIME_ENABLED=1` (below) and a **security review signs off**.
> The application code — `server/services/webpageRuntimeManager.js` (lifecycle)
> and `server/routes/webpagesFullTierProxy.js` (the HTTP+WS reverse proxy) — is
> written, reviewable, and now wired into `server/index.js`, BUT every part is
> behind `webpageRuntimeManager.isEnabled()`: with the flag unset, `ensureRuntime`
> returns null, the reaper never ticks, and the proxy + `http-proxy-middleware`
> dependency are never even `require()`d. Tom owns the deploy.

It deliberately mirrors the existing throwaway-container services
(`server/pwt-runner`, `server/terminal-runner`, `services/pwtRunner.js`) so
operators reason about one container story.

## How it fits

- A project with `settings.runtime === 'full'` (set via the `webpage_set_runtime`
  AI tool or the UI) should be served by this runtime.
- `webpageRuntimeManager.ensureRuntime({ webpageId, userId, orgId })` hydrates the
  project files from RustFS into a bind-mounted work dir, starts a capped
  container on the isolated `beeflow-webpage-net` network, waits for the dev
  server, and returns `{ reachableHost }` for the proxy.
- Light tier (default) needs none of this — it uses the in-browser esbuild-wasm
  preview + the isolated-vm `api/*.js` backend.

## Build the image

Cloud (CI → registry):

```
docker build -t ghcr.io/bee-flow/webpage-runner:latest server/webpage-runner
docker push ghcr.io/bee-flow/webpage-runner:latest
```

Self-hosted / air-gapped (local tag the manager auto-detects):

```
docker build -t beeflow-webpage-runner:local server/webpage-runner
```

## Enable (ops — after security review)

1. Ensure the API process can reach the Docker socket (already true where
   `pwt-runner` / `scan-runner` work).
2. Set env on the API service:
   - `WEBPAGE_FULL_RUNTIME_ENABLED=1`
   - `WEBPAGE_RUNNER_IMAGE=ghcr.io/bee-flow/webpage-runner:latest` (or rely on the
     `beeflow-webpage-runner:local` build)
   - Optional caps: `WEBPAGE_RUNNER_MEMORY_MB` (512), `WEBPAGE_RUNNER_CPUS` (0.5),
     `WEBPAGE_RUNNER_PIDS` (256), `WEBPAGE_RUNNER_IDLE_TTL_MS` (15m),
     `WEBPAGE_RUNNER_MAX_PER_ORG` (5).
3. **Wire-up in `server/index.js` — DONE IN CODE, gated behind the flag:**
   - `require('./services/webpageRuntimeManager').startReaper();` runs on every
     boot but no-ops unless the flag is set.
   - When `isEnabled()`, `server/routes/webpagesFullTierProxy.js`
     (`mountFullTierProxy(app, server)`) mounts:
     - HTTP: `app.use('/api/webpages-preview/:id/full', requirePreviewToken,
       dbBridgeLimiter, ensureFullTierTarget, proxy)` — forwards to
       `webpageRuntimeManager.getReachableBase(id)`.
     - WS: a `server.on('upgrade', …)` handler for Vite HMR. Browsers can't set
       an `Authorization` header on a WS handshake, so the preview token travels
       via `?token=` and is verified with `verifyPreviewToken` **before** the
       socket is handed to the proxy.
   - `WebpagePreview.jsx` points its iframe `src` at
     `/api/webpages-preview/:id/full/?token=…` when `runtime==='full'` (reusing
     the same preview token it already mints for the light-tier DB bridge).
   - **Vite base-path:** `webpageRuntimeManager.fullTierBasePath(id)` is the
     single source of truth for the mount path; it's injected into the container
     as `VITE_BASE_PATH` and read by `webpage-runner/vite.config.js` (`base`) so
     asset/HMR URLs resolve correctly behind the sub-path proxy. A project that
     ships its OWN `vite.config.*` must set `base` itself — see the checklist.

   Ops still owns the *decision* to flip `WEBPAGE_FULL_RUNTIME_ENABLED=1` after
   the security review; the code path is inert until then.

## Security model (enforced) + review checklist

Enforced by `webpageRuntimeManager.js` / this image:

- [x] Isolated bridge network `beeflow-webpage-net` — never `beeflow-network`, so
      user code can't reach postgres / rustfs / redis / the API.
- [x] `Memory` / `NanoCpus` / `PidsLimit` / `ShmSize` caps.
- [x] `SecurityOpt: ['no-new-privileges']`, `CapDrop: ['ALL']`, non-root user.
- [x] Allowlisted env only (no `process.env` spread → no secret leak).
- [x] Idle reaper (scale-to-zero) + max-age + orphan sweep.
- [x] Per-org concurrency cap (race-free — serialized per-org via an in-process
      lock around the count-then-create section, closing a TOCTOU where two
      concurrent requests for the same org could both pass the cap check
      before either container existed).
- [x] Files hydrated from RustFS; container disposable. `hydrateProject`
      additionally enforces path containment (resolved destination must stay
      inside the workdir) as defense in depth behind webpageStore's own
      `..`-rejection — a path escape here would land on the HOST bind-mount,
      not a sandboxed container.
- [x] Resource-limit env vars (`WEBPAGE_RUNNER_*`) are validated and clamped
      into sane ranges — a malformed value falls back to the default instead
      of propagating `NaN` into Docker's `HostConfig`.
- [x] `npm install` runs with `--ignore-scripts` (skips arbitrary pre/post-install
      hooks) and an explicit timeout (`INSTALL_TIMEOUT_MS`, default 120s) so a
      hung install doesn't silently eat the whole startup budget.

Must be decided/added during the security review (NOT yet implemented):

- [ ] **Egress policy.** The bridge network reaches the public internet for npm /
      esm.sh. Lock down with a network policy / egress proxy / private npm mirror
      (also fixes air-gapped installs). Decide an allowlist.
- [ ] **npm supply chain (remaining).** `--ignore-scripts` + an install timeout
      are in place (above); still open: a vetted registry mirror and
      `NPM_CONFIG_*` hardening (e.g. `NPM_CONFIG_AUDIT=false`, a size cap on
      node_modules).
- [ ] **Stronger isolation.** Evaluate a gVisor/Kata `runtimeClass` (or rootless
      docker) for the daemon, given untrusted code.
- [ ] **Proxy authn + DoS.** The reverse proxy must scope the HMAC token to the
      runtime, rate-limit, and cap request/body sizes.
- [ ] **File sync-back.** Hydration is one-way today (RustFS → container). Decide
      whether edits made in the container persist back, and how (the editor still
      writes via the existing extra-file APIs, so this may be unnecessary).
- [ ] **Bind-mount ownership.** Confirm uid mapping between host work dir and the
      container's `runner` user across the target orchestrator (K8s/Scaleway).
- [ ] **Published-app hosting.** Publishing a full-tier app to anonymous viewers
      is out of scope here — it needs its own always-on hosting design.
