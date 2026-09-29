/**
 * Playwright Runner — dockerode lifecycle for throwaway test containers.
 *
 * Each Studio test run executes in its own short-lived container built from
 * server/pwt-runner/. This module owns image resolution, the isolated network,
 * container creation/teardown, live log streaming, and orphan reaping. It
 * deliberately mirrors the patterns in services/guardInstaller.js (same docker
 * socket, isServerInContainer detection, network discovery, image pull/build,
 * log demux) so operators reason about one container story, not two.
 *
 * Isolation guarantees:
 *   • Containers attach ONLY to PWT_NETWORK — never beeflow-network — so a
 *     malicious target page driven through the browser cannot reach postgres,
 *     rustfs, redis, the guard, or the API server.
 *   • Suite containers get an allowlisted env (no process.env spread), closing
 *     the secret-leak that the old host `spawn` had.
 *   • Memory / CPU / PID caps + a reaper bound the blast radius and guarantee
 *     cleanup even if the worker crashes mid-run.
 */

const fs = require('fs');
const path = require('path');
const Docker = require('dockerode');
const log = require('../telemetry/log');

// The runner image MUST match the server's Playwright version (connect()
// rejects a minor-version mismatch). Derive the version and bake it into the
// local image tag so a version bump naturally invalidates the cached image and
// forces a rebuild instead of silently reusing a stale, mismatched runner.
let PW_VERSION = 'local';
try { PW_VERSION = require('playwright/package.json').version; } catch (_) { /* fall back */ }
const LOCAL_IMAGE_TAG = `beeflow-pwt-runner:pw-${PW_VERSION}`;

const PWT_NETWORK = 'beeflow-pwt-net';
const LABEL_KIND = 'bf.kind';
// Birth stamp on the shared browser container, same key
// services/webpageRuntimeManager.js uses for its runtimes, so a container can
// be aged from `docker ps` alone. It was referenced when building the labels
// but never declared here, so ensureBrowserSingleton threw `LABEL_BORN is not
// defined` before it ever reached docker.createContainer — surfaced to the
// caller as the catch-all "Browser backend unavailable", which reads like
// missing Docker rather than a typo. Everything needing the shared browser
// (app_screenshot, browse_web, PDF export, thumbnails) was dead on any host
// that did not already have the container.
//
// Found twice independently: once by an audit of this branch, once on
// feature/app-studio-save-as-template. The two fixes were identical.
const LABEL_BORN = 'bf.bornAt';
const SERVE_PORT = 9222;

// ── Long-lived shared browser singleton ─────────────────────────────────────
// A persistent serve container the API process drives remotely for PDF export,
// thumbnails, SPA ingestion and the browse_web / browser-agent tools. It owns
// its own liveness checks.
const BROWSER_NAME = process.env.BROWSER_CONTAINER_NAME || 'bf-browser';
const LABEL_KIND_BROWSER = 'pwt-browser';
const BROWSER_MEMORY_MB = parseInt(process.env.BROWSER_CONTAINER_MEMORY_MB || '1024', 10);
const BROWSER_CPUS = parseFloat(process.env.BROWSER_CONTAINER_CPUS || '1.0');
const BROWSER_SHM_MB = parseInt(process.env.BROWSER_CONTAINER_SHM_MB || '256', 10);
const BROWSER_READY_TIMEOUT_MS = parseInt(process.env.BROWSER_READY_TIMEOUT_MS || '60000', 10);

function getDocker() {
    return new Docker({ socketPath: '/var/run/docker.sock' });
}

/**
 * Cheap availability probe — the socket file must exist AND the daemon must
 * answer a ping. Callers use this to pick the container path vs the host
 * fallback. Cached after first success.
 */
let _available = null;
async function dockerAvailable() {
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
    try {
        if (fs.existsSync('/.dockerenv')) return true;
    } catch (_) { /* ignore */ }
    try {
        const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
        return /docker|containerd|kubepods/.test(cgroup);
    } catch (_) { /* native */ }
    return false;
}

// ── Image resolution (mirrors guardInstaller.resolveGuardImage) ─────────────

async function imageExists(docker, image) {
    try {
        await docker.getImage(image).inspect();
        return true;
    } catch (err) {
        if (err.statusCode === 404) return false;
        throw err;
    }
}

async function pullImage(docker, image, onLine) {
    await new Promise((resolve, reject) => {
        docker.pull(image, (err, stream) => {
            if (err) return reject(err);
            let lastReport = 0;
            docker.modem.followProgress(
                stream,
                (progressErr) => progressErr ? reject(progressErr) : resolve(),
                (evt) => {
                    if (!evt || !onLine) return;
                    const now = Date.now();
                    if (now - lastReport < 1000) return;
                    lastReport = now;
                    const status = evt.status || '';
                    if (/downloading|extracting|pull complete|already exists/i.test(status)) {
                        onLine(`[runner-image] ${status}${evt.id ? ` ${evt.id}` : ''}`);
                    }
                },
            );
        });
    });
}

async function buildRunnerImage(docker, image, onLine) {
    const candidates = [
        '/app/pwt-runner',
        path.resolve(__dirname, '..', 'pwt-runner'),
    ];
    const contextDir = candidates.find(c => fs.existsSync(path.join(c, 'Dockerfile')));
    if (!contextDir) {
        throw new Error(`pwt-runner Dockerfile not found (looked in: ${candidates.join(', ')})`);
    }
    onLine?.(`[runner-image] building ${image} from ${contextDir} (first run only, can take a few minutes)`);
    const { spawn } = require('child_process');
    await new Promise((resolve, reject) => {
        const proc = spawn('docker', ['build', '-t', image, contextDir], {
            env: { ...process.env, DOCKER_BUILDKIT: '1' },
        });
        let stderrTail = '';
        proc.stdout.on('data', (c) => {
            for (const line of c.toString().split('\n')) if (line.trim()) onLine?.(`[runner-image] ${line.trim()}`);
        });
        proc.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-4000); });
        proc.on('error', reject);
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`docker build exited ${code}\n${stderrTail}`)));
    });
}

let _resolvedImage = null;
async function resolvePwtImage(docker, onLine) {
    if (_resolvedImage) return _resolvedImage;

    if (process.env.PLAYWRIGHT_RUNNER_IMAGE) {
        const img = process.env.PLAYWRIGHT_RUNNER_IMAGE;
        if (!(await imageExists(docker, img))) await pullImage(docker, img, onLine);
        _resolvedImage = img;
        return img;
    }

    // Version-pinned local tag first — guarantees we never reuse a runner
    // built against a different Playwright version.
    if (await imageExists(docker, LOCAL_IMAGE_TAG)) { _resolvedImage = LOCAL_IMAGE_TAG; return LOCAL_IMAGE_TAG; }

    const tagChain = process.env.PLAYWRIGHT_RUNNER_IMAGE_TAG
        ? [process.env.PLAYWRIGHT_RUNNER_IMAGE_TAG]
        : ['dev', 'latest'];
    let lastPullErr = null;
    for (const tag of tagChain) {
        const registryImage = `ghcr.io/bee-flow/pwt-runner:${tag}`;
        try {
            await pullImage(docker, registryImage, onLine);
            _resolvedImage = registryImage;
            return registryImage;
        } catch (e) {
            lastPullErr = e;
            log.warn(`[PwtRunner] registry pull ${registryImage} failed: ${e.message}`);
        }
    }

    const buildContextExists = fs.existsSync('/app/pwt-runner/Dockerfile')
        || fs.existsSync(path.resolve(__dirname, '..', 'pwt-runner', 'Dockerfile'));
    if (!buildContextExists) {
        throw new Error(
            'Could not pull ghcr.io/bee-flow/pwt-runner and the build context is not reachable. '
            + 'Set PLAYWRIGHT_RUNNER_IMAGE to a reachable image, or ensure server/pwt-runner is present. '
            + (lastPullErr ? `(last pull error: ${lastPullErr.message})` : '')
        );
    }
    await buildRunnerImage(docker, LOCAL_IMAGE_TAG, onLine);
    _resolvedImage = LOCAL_IMAGE_TAG;
    return LOCAL_IMAGE_TAG;
}

// ── Network ─────────────────────────────────────────────────────────────────

async function ensurePwtNetwork(docker) {
    try {
        await docker.getNetwork(PWT_NETWORK).inspect();
        return;
    } catch (err) {
        if (err.statusCode !== 404) throw err;
    }
    await docker.createNetwork({ Name: PWT_NETWORK, Driver: 'bridge' });
}

/**
 * When the worker runs inside a container it must join PWT_NETWORK to reach
 * the runner by name. Idempotent — a 403 ("already exists in network") is fine.
 */
async function connectSelfToNetwork(docker) {
    const hostname = process.env.HOSTNAME;
    if (!hostname) return false;
    try {
        await docker.getNetwork(PWT_NETWORK).connect({ Container: hostname });
        return true;
    } catch (err) {
        if (err.statusCode === 403 || /already exists/i.test(err.message || '')) return true;
        log.warn('[PwtRunner] could not attach worker to pwt network:', err.message);
        return false;
    }
}

async function removeContainerIfExists(docker, name) {
    try {
        const c = docker.getContainer(name);
        try { await c.stop({ t: 3 }); } catch (_) { /* may be stopped */ }
        await c.remove({ force: true });
    } catch (err) {
        if (err.statusCode !== 404) throw err;
    }
}

// ── Log streaming ─────────────────────────────────────────────────────────

/**
 * Follow a container's combined stdout/stderr, splitting into trimmed lines and
 * invoking onLine per line. Returns a function that detaches the stream.
 * Uses demuxStream so the 8-byte multiplex headers never corrupt a line.
 */
function followLogs(docker, container, onLine) {
    const { Writable } = require('stream');
    let buf = '';
    const sink = new Writable({
        write(chunk, _enc, cb) {
            buf += chunk.toString('utf8');
            let idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (line && onLine) { try { onLine(line); } catch (_) {} }
            }
            cb();
        },
    });
    let logStream = null;
    container.logs({ follow: true, stdout: true, stderr: true }, (err, stream) => {
        if (err || !stream) return;
        logStream = stream;
        container.modem.demuxStream(stream, sink, sink);
    });
    return () => { try { logStream?.destroy(); } catch (_) {} };
}

// ── Shared browser singleton ────────────────────────────────────────────────

function browserHostConfigCaps(extra = {}) {
    return {
        Memory: Math.max(256, BROWSER_MEMORY_MB) * 1024 * 1024,
        NanoCpus: Math.round(Math.max(0.25, BROWSER_CPUS) * 1e9),
        PidsLimit: 512,
        ShmSize: Math.max(64, BROWSER_SHM_MB) * 1024 * 1024,
        Init: true,
        AutoRemove: false,
        SecurityOpt: ['no-new-privileges'],
        RestartPolicy: { Name: 'no' },
        ...extra,
    };
}

let _browserSingleton = null;   // { wsEndpoint, containerId } | { wsEndpoint, external:true }
let _browserStarting = null;    // in-flight promise to dedupe concurrent first use

/**
 * Is the cached singleton still usable? External endpoints are assumed up;
 * docker-managed ones are confirmed via inspect (Running).
 */
async function isBrowserAlive(s) {
    if (!s) return false;
    if (s.external) return true;
    try {
        const info = await getDocker().getContainer(s.containerId || BROWSER_NAME).inspect();
        return info?.State?.Running === true;
    } catch (_) {
        return false;
    }
}

/**
 * Ensure a long-lived browser is reachable and return { wsEndpoint, ... }.
 *   • BROWSER_WS_ENDPOINT set        → use it verbatim (external/sidecar), no docker.
 *   • cached singleton still alive   → reuse.
 *   • otherwise                      → (re)create the `bf-browser` serve container.
 *
 * The launchServer endpoint embeds a per-launch guid we can't recover from the
 * outside, so we always remove+recreate on a cold start to capture a fresh
 * PWT_WS_ENDPOINT line. The container reuses the same `serve` entrypoint and the
 * isolated PWT_NETWORK as the throwaway runners.
 */
async function ensureBrowserSingleton({ onLine } = {}) {
    if (process.env.BROWSER_WS_ENDPOINT) {
        return { wsEndpoint: process.env.BROWSER_WS_ENDPOINT, external: true };
    }
    if (_browserSingleton && await isBrowserAlive(_browserSingleton)) return _browserSingleton;
    if (_browserStarting) return _browserStarting;

    _browserStarting = (async () => {
        if (!(await dockerAvailable())) {
            throw new Error('docker_unavailable: cannot start the shared browser container');
        }
        const docker = getDocker();
        const image = await resolvePwtImage(docker, onLine);
        await ensurePwtNetwork(docker);
        const inContainer = isServerInContainer();
        if (inContainer) await connectSelfToNetwork(docker);
        await removeContainerIfExists(docker, BROWSER_NAME);

        const createOpts = {
            name: BROWSER_NAME,
            Image: image,
            Cmd: ['serve'],
            Env: [`PWT_SERVE_PORT=${SERVE_PORT}`],
            Labels: { [LABEL_KIND]: LABEL_KIND_BROWSER, [LABEL_BORN]: String(Date.now()) },
            WorkingDir: '/runner',
            ExposedPorts: { [`${SERVE_PORT}/tcp`]: {} },
            NetworkingConfig: { EndpointsConfig: { [PWT_NETWORK]: {} } },
        };
        const hostExtra = { NetworkMode: PWT_NETWORK };
        if (!inContainer) {
            hostExtra.PortBindings = { [`${SERVE_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '0' }] };
        }
        createOpts.HostConfig = browserHostConfigCaps(hostExtra);

        const container = await docker.createContainer(createOpts);
        let detach = () => {};
        try {
            await container.start();

            let reachableHost;
            if (inContainer) {
                reachableHost = `${BROWSER_NAME}:${SERVE_PORT}`;
            } else {
                const info = await container.inspect();
                const binding = info?.NetworkSettings?.Ports?.[`${SERVE_PORT}/tcp`]?.[0];
                const hostPort = binding?.HostPort;
                if (!hostPort) throw new Error('browser container did not publish a host port');
                reachableHost = `127.0.0.1:${hostPort}`;
            }

            const rawEndpoint = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('browser container did not report a wsEndpoint in time')), BROWSER_READY_TIMEOUT_MS);
                timer.unref?.();
                detach = followLogs(docker, container, (line) => {
                    const m = /^PWT_WS_ENDPOINT=(.+)$/.exec(line);
                    if (m) { clearTimeout(timer); resolve(m[1].trim()); }
                    else if (onLine) onLine(line);
                });
            });

            const wsEndpoint = rawEndpoint.replace(/^ws:\/\/[^/]+/, `ws://${reachableHost}`);
            _browserSingleton = { wsEndpoint, containerId: container.id };
            return _browserSingleton;
        } catch (e) {
            try { detach(); } catch (_) {}
            try { await container.stop({ t: 3 }); } catch (_) {}
            try { await container.remove({ force: true }); } catch (_) {}
            throw e;
        } finally {
            // We only needed logs to capture the endpoint line; liveness is
            // tracked via inspect afterwards, so stop following.
            try { detach(); } catch (_) {}
        }
    })().finally(() => { _browserStarting = null; });

    return _browserStarting;
}

/** Convenience: ensure the singleton and return just its ws endpoint. */
async function getBrowserEndpoint(opts) {
    const s = await ensureBrowserSingleton(opts || {});
    return s.wsEndpoint;
}

module.exports = {
    dockerAvailable,
    isServerInContainer,
    resolvePwtImage,
    ensurePwtNetwork,
    ensureBrowserSingleton,
    getBrowserEndpoint,
    isBrowserAlive,
    PWT_NETWORK,
};
