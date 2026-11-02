/**
 * Guard Service Installer
 *
 * Lifecycle management for the optional PII guard pair (guard-service + guard-redis).
 * The server spawns and removes the containers via the host Docker socket
 * (mounted at /var/run/docker.sock in docker-compose deployments).
 *
 * Source of truth for status:
 *   - configStore key `pii_guard_installed` — the installer's own state machine
 *   - presence/health of the containers themselves
 *   - HTTP /health probe of guard-service
 *
 * Not supported on Kubernetes — the Kapsule manifest owns the guard lifecycle
 * there. Callers should refuse install/uninstall when KUBERNETES_SERVICE_HOST
 * is set in the environment.
 */

const fs = require('fs');
const Docker = require('dockerode');
const configStore = require('../stores/configStore');
const { invalidateGuardEndpointCache } = require('../core/privacy/piiDetection');
const log = require('../telemetry/log');
const { resolveGuardApiKey } = require('./guardApiKey');
const { startRedis: startGuardRedis } = require('./guardRedis');
const {
    isServerInContainer, ensureNetwork,
    removeContainerIfExists: removeContainer,
} = require('./docker/dockerKit');
const { fallback, bestEffort } = require('../utils/bestEffort');
const { ensureImage, resolveGuardImage } = require('./guardImage');

const GUARD_CONTAINER = 'beeflow-guard';
const REDIS_CONTAINER = 'beeflow-guard-redis';
// Dedicated bridge network for the guard pair. Keeping it separate from the
// compose-managed `beeflow-network` (whose actual name varies with the compose
// project prefix — `bee-flow-ai_beeflow-network` in local dev) means install
// works the same way whether the server runs natively or inside a container.
const GUARD_NETWORK = 'beeflow-guard-net';
const REDIS_VOLUME = 'guard-redis-data';
const GUARD_HOST_PORT = 8100;
// First model warm-load downloads the GLiNER weights (~400 MB) from Hugging
// Face. On a fresh container this regularly takes 2-4 minutes; 5 min keeps
// us inside one HTTP polling cycle without an early cleanup.
const HEALTH_TIMEOUT_MS = 300_000;
const HEALTH_POLL_INTERVAL_MS = 3_000;

// isServerInContainer (services/docker/dockerKit) decides how the server
// reaches the guard container:
//   - server-in-container → join the server's docker network, use guard hostname
//   - server-native       → publish guard port to host, use 127.0.0.1

/**
 * When the server runs in a container, the guard container must join the
 * same docker network so the server can reach it by hostname. Discover that
 * network by inspecting the server's own container (HOSTNAME = container ID).
 * Returns null if discovery fails — caller falls back to GUARD_NETWORK only.
 */
async function discoverServerNetwork(docker) {
    const hostname = process.env.HOSTNAME;
    if (!hostname) return null;
    try {
        const info = await docker.getContainer(hostname).inspect();
        const networks = info?.NetworkSettings?.Networks || {};
        // Prefer a beeflow-suffixed network if multiple are attached.
        const names = Object.keys(networks);
        const preferred = names.find(n => /beeflow/i.test(n));
        return preferred || names[0] || null;
    } catch (_) {
        return null;
    }
}

const STATUS = {
    NOT_INSTALLED: 'not-installed',
    INSTALLING: 'installing',
    RUNNING: 'running',
    UNHEALTHY: 'unhealthy',
    UNINSTALLING: 'uninstalling',
    ERROR: 'error',
};

let _inFlight = null;

// ── Progress reporting ──────────────────────────────────────────────────
// In-memory progress state — the UI polls /status which embeds the latest.
// Stays in memory only (no DB roundtrip) so the polling endpoint is cheap;
// every install/uninstall starts fresh by overwriting it.
let _progress = null;

function _setProgress(phase, detail) {
    _progress = {
        phase,                          // 'pull' | 'build' | 'starting' | 'health' | 'cleanup' | null
        message: detail?.message || '', // human-readable subline
        percent: typeof detail?.percent === 'number' ? Math.max(0, Math.min(100, detail.percent)) : null,
        updatedAt: Date.now(),
    };
}

function _clearProgress() {
    _progress = null;
}

const DOCKER_SOCKET = '/var/run/docker.sock';
/** The one stat the installer needs before it touches Docker; swapped in tests. */
let _socketProbe = (/** @type {string} */ p) => fs.existsSync(p);

function getDocker() {
    return new Docker({ socketPath: DOCKER_SOCKET });
}

/** The default stacks no longer mount the socket: without it there is nothing to install into. */
function dockerSocketAvailable() {
    return _socketProbe(DOCKER_SOCKET);
}

function dockerSocketUnavailableReason() {
    return `Docker is not available on this install: ${DOCKER_SOCKET} is not mounted into the server. `
        + 'Run the guard as the `guard` profile of the stack instead, or opt in to the socket with '
        + 'docker-compose.docker-socket.override.yml (DOCKER_SOCKET=1 ./selfhost.sh).';
}

function isKubernetes() {
    return !!process.env.KUBERNETES_SERVICE_HOST;
}

/**
 * Probe guard-service /health. Used by both /api/guard/health and getStatus().
 * Returns the parsed body on success, or null on any failure.
 */
async function probeGuardHealth(url, apiKey) {
    if (!url) return null;
    try {
        const resp = await fetch(`${url}/health`, {
            headers: apiKey ? { 'X-API-Key': apiKey } : {},
            signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok) return null;
        return await resp.json();
    } catch (_) {
        return null;
    }
}

async function containerExists(docker, name) {
    try {
        const c = docker.getContainer(name);
        const info = await c.inspect();
        return { exists: true, running: info.State?.Running === true };
    } catch (err) {
        if (err.statusCode === 404) return { exists: false, running: false };
        throw err;
    }
}

async function getStatus() {
    const result = {
        status: STATUS.NOT_INSTALLED,
        kubernetes: isKubernetes(),
        serverInContainer: isServerInContainer(),
        url: null,
        health: null,
        lastError: null,
        containers: { guard: false, redis: false },
        progress: _progress,
        dockerSocket: true,
        unavailableReason: null,
    };

    try {
        const persisted = await configStore.getConfig('pii_guard_installed');
        if (persisted && Object.values(STATUS).includes(persisted)) {
            result.status = persisted;
        }
        result.url = await configStore.getConfig('pii_guard_url') || null;
        result.lastError = await configStore.getConfig('pii_guard_last_error') || null;
    } catch (err) { fallback('services/guardInstaller:getStatus', err); /* configStore may not be ready */ }

    // Mid-transition states are owned exclusively by _inFlight; trust them.
    if (result.status === STATUS.INSTALLING || result.status === STATUS.UNINSTALLING) {
        return result;
    }

    // On k8s we have no docker socket — skip container probing entirely and
    // just expose the env-configured URL with a /health probe.
    if (isKubernetes()) {
        const envUrl = process.env.PII_SERVICE_URL || null;
        if (envUrl) {
            result.url = envUrl;
            const health = await probeGuardHealth(envUrl, process.env.PII_SERVICE_API_KEY || '');
            if (health) {
                result.status = STATUS.RUNNING;
                result.health = health;
            } else {
                result.status = STATUS.UNHEALTHY;
            }
        }
        return result;
    }

    // No socket, no containers to probe: say so instead of logging a failed
    // probe on every status call. The persisted status still shows (an
    // install done while the socket was mounted stays reported).
    if (!dockerSocketAvailable()) {
        result.dockerSocket = false;
        result.unavailableReason = dockerSocketUnavailableReason();
        return result;
    }

    try {
        const docker = getDocker();
        const guard = await containerExists(docker, GUARD_CONTAINER);
        const redis = await containerExists(docker, REDIS_CONTAINER);
        result.containers.guard = guard.running;
        result.containers.redis = redis.running;

        if (!guard.exists && !redis.exists) {
            // Containers gone — but configStore may say running. Reconcile.
            if (result.status === STATUS.RUNNING) {
                await configStore.setConfig('pii_guard_installed', STATUS.NOT_INSTALLED);
                await configStore.setConfig('pii_guard_url', '');
                invalidateGuardEndpointCache();
            }
            result.status = STATUS.NOT_INSTALLED;
            return result;
        }

        if (guard.running) {
            const apiKey = await configStore.getSecret('pii_guard_api_key') || '';
            const probeUrl = result.url || (isServerInContainer() ? `http://${GUARD_CONTAINER}:8100` : `http://127.0.0.1:${GUARD_HOST_PORT}`);
            const health = await probeGuardHealth(probeUrl, apiKey);
            if (health) {
                result.status = STATUS.RUNNING;
                result.health = health;
            } else {
                result.status = STATUS.UNHEALTHY;
            }
        } else {
            result.status = STATUS.UNHEALTHY;
        }
    } catch (err) {
        log.warn('[GuardInstaller] Status probe failed:', err.message);
    }

    return result;
}

/**
 * Pull an image while reporting layer-aggregated download progress.
 *
 * Docker emits one event stream per layer with status transitions like
 * "Pulling fs layer" → "Downloading" (with progressDetail.current/total)
 * → "Extracting" → "Pull complete". We track the latest current/total
 * per layer ID, then sum across layers to produce a single overall percent.
 * Extract phase contributes too (Docker reports current/total for it).
 */
function removeContainerIfExists(docker, name) {
    return removeContainer(docker, name, 10);
}

/**
 * Start the guard container. The networking shape adapts to where the server
 * itself runs:
 *   - server-in-container: attach the guard to GUARD_NETWORK (for redis) AND
 *     to the server's network (so the server reaches it by hostname).
 *   - server-native:       attach to GUARD_NETWORK only, publish 8100 to
 *     127.0.0.1 so the host server can reach it via localhost.
 */
async function startGuard(docker, { apiKey, model, serverNetwork, publishPort, image }) {
    const env = [
        `GUARD_REDIS_URL=redis://${REDIS_CONTAINER}:6379/1`,
        'GUARD_PII_ENABLED=true',
        // E3-JSI/gliner-multi-pii-domains-v1 is a fine-tune of the
        // urchade/gliner_multi_pii-v1 base on Dutch + healthcare/finance/legal
        // domain text. Apache 2.0, commercial use allowed. Drop-in replacement
        // for the older model: same GLiNER label set, better Dutch recall.
        `GUARD_PII_MODEL=${model || 'E3-JSI/gliner-multi-pii-domains-v1'}`,
        `GUARD_LOG_LEVEL=${process.env.GUARD_LOG_LEVEL || 'INFO'}`,
        `SERVICES_API_KEY=${apiKey || ''}`,
    ];

    const hostConfig = {
        RestartPolicy: { Name: 'unless-stopped' },
        NetworkMode: GUARD_NETWORK,
    };

    if (publishPort) {
        hostConfig.PortBindings = {
            '8100/tcp': [{ HostIp: '127.0.0.1', HostPort: String(GUARD_HOST_PORT) }],
        };
    }

    const createOpts = {
        name: GUARD_CONTAINER,
        Image: image,
        Env: env,
        HostConfig: hostConfig,
        NetworkingConfig: {
            EndpointsConfig: { [GUARD_NETWORK]: { Aliases: [GUARD_CONTAINER] } },
        },
    };

    if (publishPort) {
        createOpts.ExposedPorts = { '8100/tcp': {} };
    }

    const container = await docker.createContainer(createOpts);

    // Attach to the server's network in a separate step (Docker only lets
    // EndpointsConfig contain one entry at create-time).
    if (serverNetwork && serverNetwork !== GUARD_NETWORK) {
        try {
            await docker.getNetwork(serverNetwork).connect({
                Container: GUARD_CONTAINER,
                EndpointConfig: { Aliases: [GUARD_CONTAINER] },
            });
        } catch (err) {
            log.warn(`[GuardInstaller] Could not attach guard to ${serverNetwork}: ${err.message}`);
        }
    }

    await container.start();
}

async function waitForHealth(url, apiKey) {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const health = await probeGuardHealth(url, apiKey);
        // Accept the guard as healthy as soon as the HTTP server is up.
        // pii_model may still be `loading` for several minutes on first run
        // (Hugging Face download + GLiNER warm-load run on a background
        // thread inside the container). PII detection fails-open until the
        // model is ready — see server/core/piiDetection.js — so
        // marking the service Running early gives a much better UX than
        // blocking the install on a slow download.
        if (health && health.status === 'ok' && (health.pii_model === 'ok' || health.pii_model === 'loading')) {
            return health;
        }
        await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
    }
    throw new Error('guard-service did not become healthy within 300s');
}

async function _doInstall({ apiKey: requestedApiKey, model }) {
    await configStore.setConfig('pii_guard_installed', STATUS.INSTALLING);
    await configStore.setConfig('pii_guard_last_error', '');
    _setProgress('starting', { message: 'Preparing install…', percent: 0 });

    // Track which step we reached so failure handling can be precise.
    // health-wait failures keep the containers around for diagnosis;
    // earlier failures wipe partial state.
    let stage = 'pre-pull';

    try {
        const docker = getDocker();
        // The guard refuses to start without a key (it fails closed): never an empty one.
        const apiKey = await resolveGuardApiKey(requestedApiKey, () => configStore.getSecret('pii_guard_api_key'));
        await ensureNetwork(docker, GUARD_NETWORK);

        // Decide how the server will reach the guard container.
        const inContainer = isServerInContainer();
        const serverNetwork = inContainer ? await discoverServerNetwork(docker) : null;
        const publishPort = !inContainer; // native server reaches via 127.0.0.1
        const guardUrl = inContainer
            ? `http://${GUARD_CONTAINER}:8100`
            : `http://127.0.0.1:${GUARD_HOST_PORT}`;

        stage = 'redis';
        await ensureImage(docker, 'redis:7-alpine', 'redis:7-alpine', _setProgress);
        _setProgress('starting', { message: 'Starting Redis cache…', percent: null });
        await removeContainerIfExists(docker, REDIS_CONTAINER);
        await startGuardRedis(docker, { container: REDIS_CONTAINER, network: GUARD_NETWORK });

        // resolveGuardImage emits its own pull/build progress events.
        stage = 'guard-image';
        const guardImage = await resolveGuardImage(docker, _setProgress);
        _setProgress('starting', { message: 'Starting guard container…', percent: null });
        await removeContainerIfExists(docker, GUARD_CONTAINER);
        stage = 'guard-start';
        await startGuard(docker, { apiKey, model, serverNetwork, publishPort, image: guardImage });

        stage = 'health';
        _setProgress('health', { message: 'Waiting for model warm-load (first run can take 3-5 min)…', percent: null });
        await waitForHealth(guardUrl, apiKey || '');

        await configStore.setConfig('pii_guard_url', guardUrl);
        await configStore.setSecret('pii_guard_api_key', apiKey);
        if (model) await configStore.setConfig('pii_guard_model', model);
        await configStore.setConfig('pii_guard_installed', STATUS.RUNNING);
        invalidateGuardEndpointCache();
        _clearProgress();
    } catch (err) {
        log.error(`[GuardInstaller] Install failed at stage=${stage}:`, err);

        // Capture the guard container's last log lines so the UI can show
        // them in lastError instead of just "did not become healthy".
        let logTail = '';
        if (stage === 'health' || stage === 'guard-start') {
            try {
                const docker = getDocker();
                const c = docker.getContainer(GUARD_CONTAINER);
                const logBuf = await c.logs({ stdout: true, stderr: true, tail: 40 });
                logTail = Buffer.isBuffer(logBuf) ? logBuf.toString('utf8') : String(logBuf);
                // strip docker log multiplex framing (8-byte headers)
                logTail = logTail.replace(/[\x00-\x08\x0B-\x1F]/g, '').slice(-3000);
            } catch (err) { fallback('services/guardInstaller:_doInstall', err); /* container may already be gone */ }
        }

        const fullError = logTail
            ? `${err.message || err}\n\n--- guard container logs (last 40 lines) ---\n${logTail}`
            : (err.message || String(err));
        await configStore.setConfig('pii_guard_last_error', fullError);
        await configStore.setConfig('pii_guard_installed', STATUS.ERROR);

        // Only wipe containers if the failure was BEFORE health-wait.
        // For health failures, keep them so the user can `docker logs
        // beeflow-guard` and rerun install (which will reuse them).
        if (stage !== 'health') {
            try {
                const docker = getDocker();
                await removeContainerIfExists(docker, GUARD_CONTAINER);
                await removeContainerIfExists(docker, REDIS_CONTAINER);
            } catch (cleanupErr) {
                log.warn('[GuardInstaller] Cleanup after failed install:', cleanupErr.message);
            }
        } else {
            log.warn('[GuardInstaller] Health timeout — keeping containers for diagnosis. Run `docker logs beeflow-guard` to investigate.');
        }
        _clearProgress();
        throw err;
    }
}

async function _doUninstall({ removeVolume }) {
    await configStore.setConfig('pii_guard_installed', STATUS.UNINSTALLING);
    _setProgress('cleanup', { message: 'Removing containers…', percent: null });

    try {
        const docker = getDocker();
        await removeContainerIfExists(docker, GUARD_CONTAINER);
        await removeContainerIfExists(docker, REDIS_CONTAINER);

        if (removeVolume) {
            _setProgress('cleanup', { message: 'Removing Redis cache volume…', percent: null });
            try {
                await docker.getVolume(REDIS_VOLUME).remove();
            } catch (err) {
                if (err.statusCode !== 404) log.warn('[GuardInstaller] Volume removal:', err.message);
            }
        }

        await configStore.setConfig('pii_guard_url', '');
        await configStore.setSecret('pii_guard_api_key', '');
        await configStore.setConfig('pii_guard_installed', STATUS.NOT_INSTALLED);
        await configStore.setConfig('pii_guard_last_error', '');
        invalidateGuardEndpointCache();
        _clearProgress();
    } catch (err) {
        log.error('[GuardInstaller] Uninstall failed:', err);
        await configStore.setConfig('pii_guard_last_error', err.message || String(err));
        await configStore.setConfig('pii_guard_installed', STATUS.ERROR);
        _clearProgress();
        throw err;
    }
}

/**
 * Kick off an install. Returns immediately with the in-flight promise so
 * the HTTP route can respond 202 while the work continues in the background.
 * Rejects with a 409-style error if another op is already running.
 */
function install({ apiKey, model } = {}) {
    if (isKubernetes()) {
        throw Object.assign(new Error('Install is not supported on Kubernetes deployments'), { code: 'UNSUPPORTED_ENV' });
    }
    if (!dockerSocketAvailable()) {
        throw Object.assign(new Error(dockerSocketUnavailableReason()), { code: 'UNSUPPORTED_ENV' });
    }
    if (_inFlight) {
        throw Object.assign(new Error('Another guard operation is already in progress'), { code: 'IN_PROGRESS' });
    }
    _inFlight = _doInstall({ apiKey, model }).finally(() => { _inFlight = null; });
    // Swallow rejection here — the error is already persisted to configStore
    // and will be reported via getStatus(). Otherwise Node logs an unhandled
    // rejection because the HTTP handler has already returned 202.
    _inFlight.catch((e) => bestEffort('services/guardInstaller:install', e));
    return _inFlight;
}

function uninstall({ removeVolume = false } = {}) {
    if (isKubernetes()) {
        throw Object.assign(new Error('Uninstall is not supported on Kubernetes deployments'), { code: 'UNSUPPORTED_ENV' });
    }
    if (!dockerSocketAvailable()) {
        throw Object.assign(new Error(dockerSocketUnavailableReason()), { code: 'UNSUPPORTED_ENV' });
    }
    if (_inFlight) {
        throw Object.assign(new Error('Another guard operation is already in progress'), { code: 'IN_PROGRESS' });
    }
    _inFlight = _doUninstall({ removeVolume }).finally(() => { _inFlight = null; });
    _inFlight.catch((e) => bestEffort('services/guardInstaller:uninstall', e));
    return _inFlight;
}

module.exports = {
    getStatus,
    install,
    uninstall,
    probeGuardHealth,
    isKubernetes,
    isServerInContainer,
    dockerSocketAvailable,
    dockerSocketUnavailableReason,
    /** @param {((p: string) => boolean) | null} probe */
    _setSocketProbeForTests(probe) { _socketProbe = probe || ((p) => fs.existsSync(p)); },
    STATUS,
};

/** @typedef {InstanceType<typeof Docker>} DockerClient */

/** @typedef {{ phase: string | null, message: string, percent: number | null, updatedAt: number }} GuardProgress */
