/**
 * Webpage FULL-tier runtime manager — per-project Node.js dev container.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ STATUS: GATED + INERT BY DEFAULT. This module never starts a container   │
 * │ unless WEBPAGE_FULL_RUNTIME_ENABLED=1 AND a Docker daemon is reachable.   │
 * │ It is NOT wired into server startup or any request path yet. Enabling it  │
 * │ in production REQUIRES a dedicated security review (see                   │
 * │ server/webpage-runner/README.md). Tom owns the deploy — this file only    │
 * │ provides the reviewable implementation.                                   │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * When a project's settings.runtime === 'full', its app runs a real Vite dev
 * server + (optional) Node backend inside a throwaway-but-warm container, and
 * the editor preview iframe points at that container through a reverse proxy.
 * This natively gives real npm, ES modules, JSX/TSX and Material UI — no
 * in-browser bundler — at the cost of one capped, idle-reaped container per
 * actively-edited project.
 *
 * Design mirrors the battle-tested server/services/pwtRunner.js lifecycle:
 *   • Containers attach ONLY to an isolated bridge network (never beeflow-network),
 *     so user code cannot reach postgres / rustfs / redis / the API server.
 *   • Memory / CPU / PID caps + no-new-privileges + a non-root image + an
 *     allowlisted env (no process.env spread) bound the blast radius.
 *   • A reaper stops idle/aged containers (scale-to-zero); a per-org concurrency
 *     cap stops one tenant exhausting the node.
 *   • Project files are hydrated from RustFS into a bind-mounted work dir on
 *     start and are the source of truth — the container is disposable.
 *
 * Everything here is best-effort + defensive: if Docker is absent or the gate
 * is off, callers fall back to the light tier (esbuild-wasm preview +
 * isolated-vm api handlers).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const webpageStore = require('../stores/webpageStore');
const log = require('../telemetry/log');

// ── Gate + tunables ─────────────────────────────────────────────────────────

const NETWORK = 'beeflow-webpage-net';
const LABEL_KIND = 'bf.kind';
const LABEL_KIND_VALUE = 'webpage-runtime';
const LABEL_WP = 'bf.webpageId';
const LABEL_BORN = 'bf.bornAt';
const DEV_PORT = 5173; // Vite dev server inside the container

// A malformed tunable (typo, empty string, negative) must clamp to something
// safe rather than propagate NaN into Docker's HostConfig — an unvalidated
// `Math.max(256, NaN) * 1024 * 1024` silently becomes NaN, which dockerode
// either rejects opaquely or (worse) Docker's API coerces unpredictably.
function envInt(name, fallback, { min = 0, max = Infinity } = {}) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) {
        log.warn(`[WebpageRuntime] ${name}="${raw}" is not a valid integer — using default ${fallback}`);
        return fallback;
    }
    return Math.min(max, Math.max(min, n));
}
function envFloat(name, fallback, { min = 0, max = Infinity } = {}) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) {
        log.warn(`[WebpageRuntime] ${name}="${raw}" is not a valid number — using default ${fallback}`);
        return fallback;
    }
    return Math.min(max, Math.max(min, n));
}

const MEMORY_MB = envInt('WEBPAGE_RUNNER_MEMORY_MB', 512, { min: 256, max: 8192 });
const CPUS = envFloat('WEBPAGE_RUNNER_CPUS', 0.5, { min: 0.25, max: 8 });
const PIDS_LIMIT = envInt('WEBPAGE_RUNNER_PIDS', 256, { min: 32, max: 4096 });
const SHM_MB = envInt('WEBPAGE_RUNNER_SHM_MB', 128, { min: 64, max: 2048 });
const IDLE_TTL_MS = envInt('WEBPAGE_RUNNER_IDLE_TTL_MS', 15 * 60_000, { min: 60_000, max: 24 * 60 * 60_000 });
const MAX_AGE_MS = envInt('WEBPAGE_RUNNER_MAX_AGE_MS', 4 * 60 * 60_000, { min: IDLE_TTL_MS, max: 7 * 24 * 60 * 60_000 });
const READY_TIMEOUT_MS = envInt('WEBPAGE_RUNNER_READY_TIMEOUT_MS', 90_000, { min: 5_000, max: 10 * 60_000 });
// How long a freshly created container is presumed to be cold-starting rather
// than orphaned. createRuntime() only registers a container in `runtimes` after
// waitForReady() resolves, so for the whole boot window it is indistinguishable
// from an orphan to the reaper below — and the reaper ticks every 60s while a
// normal npm/Vite boot takes tens of seconds. The window is the ready timeout
// plus slack for the create/start/inspect round-trips that precede it.
const STARTUP_GRACE_MS = READY_TIMEOUT_MS + 30_000;
const MAX_PER_ORG = envInt('WEBPAGE_RUNNER_MAX_PER_ORG', 5, { min: 1, max: 100 });
const WORK_ROOT = process.env.WEBPAGE_RUNNER_WORK_DIR || path.join(os.tmpdir(), 'beeflow-webpage-runtimes');

/** The hard gate. Both the flag AND a reachable Docker daemon are required. */
function isEnabled() {
    return process.env.WEBPAGE_FULL_RUNTIME_ENABLED === '1';
}

let _dockerode = null;
function getDocker() {
    if (!_dockerode) _dockerode = require('dockerode');
    return new _dockerode({ socketPath: '/var/run/docker.sock' });
}

let _available = null;
async function dockerAvailable() {
    if (!isEnabled()) return false;
    if (_available !== null) return _available;
    try {
        if (!fs.existsSync('/var/run/docker.sock')) { _available = false; return false; }
        await getDocker().ping();
        _available = true;
    } catch (_) {
        _available = false;
    }
    return _available;
}

function isServerInContainer() {
    try { if (fs.existsSync('/.dockerenv')) return true; } catch (_) { /* ignore */ }
    try {
        const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
        return /docker|containerd|kubepods/.test(cgroup);
    } catch (_) { /* native */ }
    return false;
}

function containerName(webpageId) {
    return `bf-wp-${String(webpageId).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40)}`;
}

function runtimeLabels(webpageId, orgId) {
    return {
        [LABEL_KIND]: LABEL_KIND_VALUE,
        [LABEL_WP]: String(webpageId),
        'bf.orgId': String(orgId || ''),
        [LABEL_BORN]: String(Date.now()),
    };
}

// Single source of truth for the path this webpage's full-tier proxy mounts
// at — both the container's VITE_BASE_PATH env (above) and the reverse proxy
// (server/routes/webpagesFullTierProxy.js) derive from this SAME function so
// they can never drift apart into two different strings.
function fullTierBasePath(webpageId) {
    return `/api/webpages-preview/${encodeURIComponent(webpageId)}/full/`;
}

/**
 * Locked-down HostConfig — copied from pwtRunner.hostConfigCaps and tightened.
 * No process.env spread anywhere; the container only sees the allowlisted env
 * passed at create time.
 */
function hostConfigCaps(extra = {}) {
    return {
        Memory: Math.max(256, MEMORY_MB) * 1024 * 1024,
        NanoCpus: Math.round(Math.max(0.25, CPUS) * 1e9),
        PidsLimit: PIDS_LIMIT,
        ShmSize: Math.max(64, SHM_MB) * 1024 * 1024,
        Init: true,
        AutoRemove: false,
        SecurityOpt: ['no-new-privileges'],
        CapDrop: ['ALL'],
        RestartPolicy: { Name: 'no' },
        ...extra,
    };
}

// ── Image resolution (mirrors pwtRunner.resolvePwtImage) ────────────────────

const LOCAL_IMAGE_TAG = 'beeflow-webpage-runner:local';
let _resolvedImage = null;

async function imageExists(docker, image) {
    try { await docker.getImage(image).inspect(); return true; }
    catch (err) { if (err.statusCode === 404) return false; throw err; }
}

async function resolveImage(docker) {
    if (_resolvedImage) return _resolvedImage;
    if (process.env.WEBPAGE_RUNNER_IMAGE) {
        _resolvedImage = process.env.WEBPAGE_RUNNER_IMAGE;
        return _resolvedImage;
    }
    if (await imageExists(docker, LOCAL_IMAGE_TAG)) { _resolvedImage = LOCAL_IMAGE_TAG; return LOCAL_IMAGE_TAG; }
    // Registry pull (cloud) — falls through to a local build (self-host/air-gapped)
    // performed out-of-band; we do NOT build implicitly here to avoid a slow,
    // surprising first request. Ops builds the image (see webpage-runner/README).
    const registry = process.env.WEBPAGE_RUNNER_REGISTRY_IMAGE || 'ghcr.io/bee-flow/webpage-runner:latest';
    try {
        await new Promise((resolve, reject) => {
            docker.pull(registry, (err, stream) => {
                if (err) return reject(err);
                docker.modem.followProgress(stream, (e) => e ? reject(e) : resolve());
            });
        });
        _resolvedImage = registry;
        return registry;
    } catch (e) {
        throw new Error(`webpage-runner image unavailable. Build it (server/webpage-runner) or set WEBPAGE_RUNNER_IMAGE. (${e.message})`);
    }
}

async function ensureNetwork(docker) {
    try { await docker.getNetwork(NETWORK).inspect(); return; }
    catch (err) { if (err.statusCode !== 404) throw err; }
    // `internal: false` so the container can reach the public internet (npm/CDN)
    // but NOT the host's other docker networks. Egress restriction is an infra
    // concern (network policy) — see the security-review checklist.
    await docker.createNetwork({ Name: NETWORK, Driver: 'bridge' });
}

async function connectSelfToNetwork(docker) {
    const hostname = process.env.HOSTNAME;
    if (!hostname) return false;
    try { await docker.getNetwork(NETWORK).connect({ Container: hostname }); return true; }
    catch (err) { if (err.statusCode === 403 || /already exists/i.test(err.message || '')) return true; return false; }
}

// ── Project hydration ───────────────────────────────────────────────────────

/**
 * Materialise a project's files (3 slots + extras) into `workdir` so the
 * container's bind-mount sees a real source tree. RustFS stays the source of
 * truth; the container is disposable. Returns the file count written.
 */
async function hydrateProject(webpageId, userId, workdir) {
    await fsp.mkdir(workdir, { recursive: true });
    const workdirResolved = path.resolve(workdir);
    let count = 0;
    // Belt-and-braces containment: webpageStore.listExtraFiles/readExtraFile
    // already reject `..` segments upstream, but a bind-mounted host directory
    // makes a path-escape here far more consequential (host filesystem, not a
    // sandboxed container) — worth a second, cheap check at the point the path
    // actually leaves the process.
    const writeFile = async (rel, content) => {
        const dest = path.resolve(workdir, rel);
        if (dest !== workdirResolved && !dest.startsWith(workdirResolved + path.sep)) {
            log.warn(`[WebpageRuntime] Refusing to hydrate path outside workdir: ${rel}`);
            return;
        }
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, content);
        count++;
    };

    const slots = await webpageStore.readAllSlots(userId, webpageId).catch(() => ({}));
    if (slots.html) await writeFile('index.html', slots.html);
    if (slots.css) await writeFile('style.css', slots.css);
    if (slots.js) await writeFile('script.js', slots.js);

    const extras = await webpageStore.listExtraFiles(webpageId).catch(() => []);
    for (const meta of extras) {
        try {
            const f = await webpageStore.readExtraFile({ webpageId, userId, path: meta.path });
            if (!f) continue;
            await writeFile(meta.path, f.meta.isText ? f.text : f.bytes);
        } catch (_) { /* skip individual file failures */ }
    }
    return count;
}

// ── Runtime registry + lifecycle ────────────────────────────────────────────

// webpageId → { containerId, lastAccess, reachableHost }
const runtimes = new Map();

function touch(webpageId) {
    const e = runtimes.get(webpageId);
    if (e) e.lastAccess = Date.now();
}

async function countOrgContainers(docker, orgId) {
    if (!orgId) return 0;
    const list = await docker.listContainers({ all: false, filters: { label: [`${LABEL_KIND}=${LABEL_KIND_VALUE}`, `bf.orgId=${orgId}`] } });
    return list.length;
}

async function removeContainerIfExists(docker, name) {
    try {
        const c = docker.getContainer(name);
        try { await c.stop({ t: 3 }); } catch (_) { /* may be stopped */ }
        await c.remove({ force: true });
    } catch (err) { if (err.statusCode !== 404) throw err; }
}

// ── Per-org creation lock ────────────────────────────────────────────────
//
// countOrgContainers() (the cap check) and docker.createContainer() (the
// mutation) are two separate round-trips with an await gap between them. Two
// concurrent ensureRuntime() calls for the SAME org (opening two different
// projects' editors at once) could both read the pre-creation count, both
// pass the check, and both create — exceeding MAX_PER_ORG. Since this whole
// manager is in-process, a Promise-chain mutex per orgId is enough to
// serialize the check-then-create section without needing a distributed lock.
const orgLocks = new Map(); // orgId -> tail of the promise chain
function withOrgLock(orgId, fn) {
    if (!orgId) return fn(); // ungrouped requests have nothing to serialize against
    const prev = orgLocks.get(orgId) || Promise.resolve();
    const result = prev.then(fn, fn);
    // The chain's tail must never reject (or every later caller for this org
    // would inherit a stale rejection) — the real error/result still reaches
    // this call's own caller via `result`.
    orgLocks.set(orgId, result.catch(() => {}));
    return result;
}

/**
 * Ensure a running dev container for this project and return its reachable base
 * { reachableHost, containerId } for the reverse proxy, or null when the full
 * tier is unavailable (gate off / no docker) so the caller can fall back to the
 * light tier. Hydrates the project files on cold start.
 */
async function ensureRuntime({ webpageId, userId, orgId }) {
    if (!(await dockerAvailable())) return null;

    const existing = runtimes.get(webpageId);
    if (existing) {
        try {
            const info = await getDocker().getContainer(existing.containerId).inspect();
            if (info?.State?.Running) { touch(webpageId); return existing; }
        } catch (_) { runtimes.delete(webpageId); }
    }

    return withOrgLock(orgId, () => createRuntime({ webpageId, userId, orgId }));
}

async function createRuntime({ webpageId, userId, orgId }) {
    // Re-check now that we hold this org's lock — a concurrent call for this
    // SAME webpageId may have finished creating the container while we waited.
    const reentry = runtimes.get(webpageId);
    if (reentry) {
        try {
            const info = await getDocker().getContainer(reentry.containerId).inspect();
            if (info?.State?.Running) { touch(webpageId); return reentry; }
        } catch (_) { runtimes.delete(webpageId); }
    }

    const docker = getDocker();

    // Per-org concurrency cap — now race-free, serialized by withOrgLock above.
    if (MAX_PER_ORG > 0 && (await countOrgContainers(docker, orgId)) >= MAX_PER_ORG) {
        throw new Error(`Runtime limit reached for this organisation (${MAX_PER_ORG} concurrent projects). Close another project's editor and retry.`);
    }

    const image = await resolveImage(docker);
    await ensureNetwork(docker);
    const inContainer = isServerInContainer();
    if (inContainer) await connectSelfToNetwork(docker);

    const workdir = path.join(WORK_ROOT, String(webpageId));
    await hydrateProject(webpageId, userId, workdir);

    const name = containerName(webpageId);
    await removeContainerIfExists(docker, name);

    const createOpts = {
        name,
        Image: image,
        // Allowlisted env ONLY — never spread process.env (secret-leak guard).
        // VITE_BASE_PATH tells the project's dev server (via
        // server/webpage-runner/vite.config.js, when a project ships no
        // vite.config of its own) to emit asset/HMR URLs prefixed with the
        // exact path the reverse proxy (server/routes/webpagesFullTierProxy.js)
        // mounts this webpage at — without it, root-relative asset URLs in the
        // served HTML resolve against the wrong origin path once behind a
        // sub-path proxy. A project with its OWN vite.config.js won't read
        // this automatically; that's a documented limitation (see the
        // webpage-runner README) until such projects are taught to.
        Env: [`PORT=${DEV_PORT}`, `HOST=0.0.0.0`, 'NODE_ENV=development', 'CI=1', `VITE_BASE_PATH=${fullTierBasePath(webpageId)}`],
        Labels: runtimeLabels(webpageId, orgId),
        WorkingDir: '/project',
        ExposedPorts: { [`${DEV_PORT}/tcp`]: {} },
        NetworkingConfig: { EndpointsConfig: { [NETWORK]: {} } },
    };
    const hostExtra = { NetworkMode: NETWORK, Binds: [`${workdir}:/project:rw`] };
    if (!inContainer) {
        hostExtra.PortBindings = { [`${DEV_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '0' }] };
    }
    createOpts.HostConfig = hostConfigCaps(hostExtra);

    const container = await docker.createContainer(createOpts);
    await container.start();

    // Resolve the address the proxy uses to reach the dev server.
    let reachableHost;
    if (inContainer) {
        reachableHost = `${name}:${DEV_PORT}`;
    } else {
        const info = await container.inspect();
        const binding = info?.NetworkSettings?.Ports?.[`${DEV_PORT}/tcp`]?.[0];
        if (!binding?.HostPort) { await container.remove({ force: true }).catch(() => {}); throw new Error('dev container did not publish a port'); }
        reachableHost = `127.0.0.1:${binding.HostPort}`;
    }

    await waitForReady(reachableHost).catch(async (e) => {
        await container.remove({ force: true }).catch(() => {});
        throw e;
    });

    const entry = { containerId: container.id, lastAccess: Date.now(), reachableHost };
    runtimes.set(webpageId, entry);
    return entry;
}

/** Poll the dev server's TCP/HTTP until it answers or we time out. */
async function waitForReady(reachableHost) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    const url = `http://${reachableHost}/`;
    while (Date.now() < deadline) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 2000);
            const res = await fetch(url, { signal: ctrl.signal });
            clearTimeout(t);
            if (res.status > 0) return true;
        } catch (_) { /* not up yet */ }
        await new Promise(r => setTimeout(r, 750));
    }
    throw new Error('dev server did not become ready in time');
}

/** Base URL for the reverse proxy. Call touch() on every proxied request. */
async function getReachableBase(webpageId) {
    const e = runtimes.get(webpageId);
    if (!e) return null;
    touch(webpageId);
    return `http://${e.reachableHost}`;
}

async function stopRuntime(webpageId) {
    const e = runtimes.get(webpageId);
    runtimes.delete(webpageId);
    if (!(await dockerAvailable())) return;
    try { await removeContainerIfExists(getDocker(), containerName(webpageId)); } catch (_) { /* ignore */ }
    if (e) {
        try { await fsp.rm(path.join(WORK_ROOT, String(webpageId)), { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
}

/**
 * Reap decision for ONE listed container. Pure — no Docker, no clock — so the
 * cold-start grace is unit-testable without a daemon.
 *
 * @param {object}  c
 * @param {string}  c.state  container State from listContainers ('running', …)
 * @param {number}  c.born   bf.bornAt label as epoch ms (0 when absent)
 * @param {object?} c.entry  this webpage's `runtimes` entry, if it is registered
 * @param {number}  c.now    current epoch ms
 */
function shouldReap({ state, born, entry, now }) {
    const dead = state === 'exited' || state === 'dead';
    const neverStarted = state === 'created';
    // A container with no `runtimes` entry is normally an orphan from a crashed
    // worker — but it is ALSO exactly what an in-flight cold start looks like,
    // because createRuntime() registers the entry only after the dev server
    // answers. Reaping one of those stops+removes the container and deletes its
    // freshly hydrated workdir out from under waitForReady(), so a project that
    // boots slower than a reaper tick could never open its full-tier preview.
    // Give every young container the full boot window; real orphans are still
    // swept, one grace period later.
    if (!entry && !dead && born > 0 && (now - born) < STARTUP_GRACE_MS) return false;

    const idle = entry ? (now - entry.lastAccess) > IDLE_TTL_MS : true; // unknown → orphan
    const tooOld = born > 0 && (now - born) > MAX_AGE_MS;
    return idle || tooOld || dead || neverStarted;
}

/**
 * Scale-to-zero reaper: stop containers idle past IDLE_TTL_MS or older than
 * MAX_AGE_MS, and sweep orphans from a crashed worker. Mirrors
 * pwtRunner.reapStaleRunners. Call from startReaper() — NOT auto-run at import.
 */
async function reapIdle() {
    if (!(await dockerAvailable())) return { reaped: 0 };
    let reaped = 0;
    const docker = getDocker();
    const now = Date.now();
    try {
        const containers = await docker.listContainers({ all: true, filters: { label: [`${LABEL_KIND}=${LABEL_KIND_VALUE}`] } });
        for (const c of containers) {
            const webpageId = c.Labels?.[LABEL_WP];
            const born = parseInt(c.Labels?.[LABEL_BORN] || '0', 10);
            const entry = webpageId ? runtimes.get(webpageId) : null;
            if (shouldReap({ state: c.State, born, entry, now })) {
                try {
                    const cont = docker.getContainer(c.Id);
                    try { await cont.stop({ t: 3 }); } catch (_) {}
                    await cont.remove({ force: true });
                    if (webpageId) {
                        runtimes.delete(webpageId);
                        try { await fsp.rm(path.join(WORK_ROOT, String(webpageId)), { recursive: true, force: true }); } catch (_) {}
                    }
                    reaped++;
                } catch (_) { /* already gone */ }
            }
        }
    } catch (e) {
        log.warn('[WebpageRuntime] reap failed:', e.message);
    }
    return { reaped };
}

let _reaperTimer = null;
function startReaper() {
    if (!isEnabled() || _reaperTimer) return;
    _reaperTimer = setInterval(() => { reapIdle().catch(() => {}); }, 60_000);
    _reaperTimer.unref?.();
}
function stopReaper() {
    if (_reaperTimer) { clearInterval(_reaperTimer); _reaperTimer = null; }
}

module.exports = {
    isEnabled,
    dockerAvailable,
    ensureRuntime,
    getReachableBase,
    touch,
    stopRuntime,
    reapIdle,
    startReaper,
    stopReaper,
    hydrateProject,
    fullTierBasePath,
    NETWORK,
    DEV_PORT,
    // Test-only
    _envInt: envInt,
    _envFloat: envFloat,
    _withOrgLock: withOrgLock,
    _shouldReap: shouldReap,
    _STARTUP_GRACE_MS: STARTUP_GRACE_MS,
};
