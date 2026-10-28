/**
 * Security Scan Runner — dockerode lifecycle for throwaway scanner containers.
 *
 * Each security scan executes one or more scanner engines (ZAP / nuclei /
 * testssl.sh), and every engine runs in its own short-lived container. This
 * module owns image resolution, the isolated scan network, container
 * creation/teardown, live log streaming, and orphan reaping. It deliberately
 * mirrors services/pwtRunner.js (same docker socket, isServerInContainer
 * detection, network discovery, image pull, log demux) so operators reason
 * about one container story across both runners.
 *
 * Isolation guarantees:
 *   • Scanner and toolbox containers attach ONLY to SCAN_NETWORK — never
 *     beeflow-network — so an off-the-shelf scanner image driven against an
 *     attacker-supplied target cannot reach postgres, rustfs, redis, the guard,
 *     or the API server.
 *   • The API server never joins SCAN_NETWORK (and leaves it when an older
 *     version left it attached). When it runs in a container it reaches the
 *     toolbox's ZAP API through a per-toolbox relay: a socat container on
 *     CONTROL_NETWORK (Internal, no egress; only the server and relays) and on
 *     SCAN_NETWORK, that forwards one port to one target and runs as nobody
 *     with every capability dropped, a read-only root and IP forwarding off.
 *     A native server reaches ZAP via a port published on 127.0.0.1.
 *   • Scanner images are pinned by digest (each overridable by env).
 *   • Memory / CPU / PID caps + a reaper bound the blast radius and guarantee
 *     cleanup even if the worker crashes mid-scan.
 *   • This module never reads the scanner report files — it only runs the
 *     container and streams its logs. The worker reads workdir/report.json
 *     after runEngineContainer resolves.
 *
 * The cheap docker helpers (getDocker / dockerAvailable / isServerInContainer /
 * imageExists / pullImage style) duplicate pwtRunner's — they are a handful of
 * lines and duplicating them keeps the two runners independently readable and
 * avoids coupling scan availability to the playwright runner's module state.
 */

const fs = require('fs');
const crypto = require('crypto');
const Docker = require('dockerode');
const { errMessage, statusCodeOf } = require('./errors');

/**
 * @typedef {InstanceType<typeof Docker>} DockerClient
 * @typedef {import('dockerode').Container} DockerContainer
 *
 * A line of output goes to a callback like this; null/undefined means nobody listens.
 * @typedef {((line: string) => void) | null | undefined} LineSink
 *
 * One chunk of a command's output, as streamed to `onChunk`.
 * @typedef {{ stream: 'stdout' | 'stderr', chunk: string }} OutputChunk
 *
 * Run a shell command in a container and stream its output.
 * @typedef {(command: string, options?: { onChunk?: (chunk: OutputChunk) => void, timeoutMs?: number }) => Promise<{ exitCode: number, timedOut: boolean }>} ExecFn
 *
 * A live ZAP daemon, as the ZAP client needs to reach it.
 * @typedef {{ baseUrl: string, apiKey: string }} ZapEndpoint
 *
 * A running toolbox: the agent's shell, its ZAP daemon, and the way to tear both down.
 * @typedef {{ zap: ZapEndpoint, containerId: string, relayContainerId?: string | null, exec: ExecFn, cleanup: () => Promise<void> }} ToolboxHandle
 * @typedef {'zap' | 'nuclei' | 'testssl'} ScanEngine
 */

const SCAN_NETWORK = 'beeflow-scan-net';
const CONTROL_NETWORK = 'beeflow-scan-ctl';
const LABEL_KIND = 'bf.kind';
const LABEL_KIND_VALUE = 'scan-runner';
const LABEL_SCAN = 'bf.scanId';
const LABEL_BORN = 'bf.bornAt';
const LABEL_PREWARM = 'bf.prewarm';

// Pre-warm: an unclaimed warm toolbox is released after this TTL (in-memory
// sweep); the reaper also removes any prewarm container older than the backstop
// (covers orphans left after a process restart loses the registry).
const PREWARM_TTL_MS = parseInt(process.env.SECURITY_PREWARM_TTL_MS || '300000', 10); // 5 min
const PREWARM_BACKSTOP_MS = parseInt(process.env.SECURITY_PREWARM_BACKSTOP_MS || '900000', 10); // 15 min

const MEMORY_MB = parseInt(process.env.SECURITY_SCANNER_MEMORY_MB || '1536', 10);
const CPUS = parseFloat(process.env.SECURITY_SCANNER_CPUS || '1.0');
const MAX_AGE_MS = parseInt(process.env.SECURITY_SCANNER_MAX_AGE_MS || '3600000', 10); // 60 min — full scans are slow

// Agent-mode (live, AI-driven) extras. The toolbox (tools + in-container ZAP
// daemon) is a long-lived container driven by the agent; it carries the same
// bf.scanId label so killScan()/reapStaleRunners() tear it down too.
// ZAP 2.17 daemon cold-boot loads every passive/active rule + the callback
// service before the REST port opens — that's ~60-90s on a cold container, so
// the readiness budget is generous.
const ZAP_BOOT_TIMEOUT_MS = parseInt(process.env.SECURITY_ZAP_BOOT_TIMEOUT_MS || '120000', 10);
const TOOLS_IMAGE = process.env.SECURITY_TOOLS_IMAGE || 'beeflow-security-tools:latest';

// Default images per engine, pinned by digest so a re-tagged upstream image
// never changes what runs. Each can be overridden via its env var. To move a
// pin: `docker buildx imagetools inspect <repo>:<tag>` and copy the Digest.
/** @type {Record<string, string>} */
const PINNED_IMAGES = {
    // ghcr.io/zaproxy/zaproxy:stable as of 2026-10-28
    zap: 'ghcr.io/zaproxy/zaproxy@sha256:030d3df57735dacbb83464854758e674dd9ad01d79d12a129a8e58b1fd384238',
    // projectdiscovery/nuclei:v3.11.1
    nuclei: 'projectdiscovery/nuclei@sha256:582d5546902e67052097cb2d07296c642d50a1afc5e44623cb038845df9a32eb',
    // drwetter/testssl.sh:latest as of 2026-10-28
    testssl: 'drwetter/testssl.sh@sha256:80f7320a16127f0294c90c2a5fa4e518a48eecda1b94766ed4717b41cb6bc178',
    // alpine/socat:1.8.1.3, the ZAP control relay
    relay: 'alpine/socat@sha256:603174b77eebaba25ba8f8ebb15e1234d6600409554e95d6fb203fd106150287',
};
/** @type {Record<string, string>} */
const DEFAULT_IMAGES = {
    zap: process.env.SECURITY_SCANNER_ZAP_IMAGE || PINNED_IMAGES.zap,
    nuclei: process.env.SECURITY_SCANNER_NUCLEI_IMAGE || PINNED_IMAGES.nuclei,
    testssl: process.env.SECURITY_SCANNER_TESTSSL_IMAGE || PINNED_IMAGES.testssl,
};
const RELAY_IMAGE = process.env.SECURITY_ZAP_RELAY_IMAGE || PINNED_IMAGES.relay;

// Tests swap the docker client and the in-container probe (see __test below).
/** @type {(() => DockerClient) | null} */
let _dockerOverride = null;
/** @type {boolean | null} */
let _inContainerOverride = null;

/** @returns {DockerClient} */
function getDocker() {
    if (_dockerOverride) return _dockerOverride();
    return new Docker({ socketPath: '/var/run/docker.sock' });
}

/**
 * Cheap availability probe — the socket file must exist AND the daemon must
 * answer a ping. The worker uses this to decide whether scans can run at all
 * (there is no host fallback for security scans). Cached after first success.
 * @type {boolean | null}
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
    if (_inContainerOverride !== null) return _inContainerOverride;
    try {
        if (fs.existsSync('/.dockerenv')) return true;
    } catch (_) { /* ignore */ }
    try {
        const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
        return /docker|containerd|kubepods/.test(cgroup);
    } catch (_) { /* native */ }
    return false;
}

/**
 * @param {unknown} scanId
 * @param {string} engine
 * @returns {string}
 */
function containerName(scanId, engine) {
    const safeId = String(scanId).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 32);
    const safeEngine = String(engine).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 12);
    return `bf-scan-${safeId}-${safeEngine}`;
}

/**
 * @param {unknown} scanId
 * @returns {Record<string, string>}
 */
function runnerLabels(scanId) {
    return {
        [LABEL_KIND]: LABEL_KIND_VALUE,
        [LABEL_SCAN]: String(scanId),
        [LABEL_BORN]: String(Date.now()),
    };
}

/**
 * @param {import('dockerode').HostConfig} [extra]
 * @returns {import('dockerode').HostConfig}
 */
function hostConfigCaps(extra = {}) {
    return {
        Memory: Math.max(256, MEMORY_MB) * 1024 * 1024,
        NanoCpus: Math.round(Math.max(0.25, CPUS) * 1e9),
        PidsLimit: 512,
        Init: true,
        AutoRemove: false, // explicit removal — AutoRemove races with log/report reads
        SecurityOpt: ['no-new-privileges'],
        RestartPolicy: { Name: 'no' },
        ...extra,
    };
}

// ── Image resolution (mirrors pwtRunner.resolvePwtImage) ────────────────────

/**
 * @param {DockerClient} docker
 * @param {string} image
 * @returns {Promise<boolean>}
 */
async function imageExists(docker, image) {
    try {
        await docker.getImage(image).inspect();
        return true;
    } catch (err) {
        if (statusCodeOf(err) === 404) return false;
        throw err;
    }
}

/**
 * @param {DockerClient} docker
 * @param {string} image
 * @param {LineSink} [onLine]
 */
async function pullImage(docker, image, onLine) {
    await new Promise((resolve, reject) => {
        docker.pull(image, (err, stream) => {
            if (err) return reject(err);
            let lastReport = 0;
            docker.modem.followProgress(
                stream,
                (progressErr) => progressErr ? reject(progressErr) : resolve(undefined),
                (evt) => {
                    if (!evt || !onLine) return;
                    const now = Date.now();
                    if (now - lastReport < 1000) return;
                    lastReport = now;
                    const status = evt.status || '';
                    if (/downloading|extracting|pull complete|already exists/i.test(status)) {
                        onLine(`[scanner-image] ${status}${evt.id ? ` ${evt.id}` : ''}`);
                    }
                },
            );
        });
    });
}

/**
 * Resolve the image for an engine: honour the per-engine env override, else the
 * baked default tag. Pull it if it isn't present locally. Resolved images are
 * cached per-engine so a multi-engine scan only inspects/pulls once.
 * @type {Record<string, string>}
 */
const _resolvedImages = {};
/**
 * @param {string} engine
 * @param {LineSink} [onLine]
 * @returns {Promise<string>}
 */
async function resolveScanImage(engine, onLine) {
    if (_resolvedImages[engine]) return _resolvedImages[engine];

    const image = DEFAULT_IMAGES[engine];
    if (!image) throw new Error(`unknown scanner engine: ${engine}`);

    if (!(await imageExists(getDocker(), image))) {
        await pullImage(getDocker(), image, onLine);
    }
    _resolvedImages[engine] = image;
    return image;
}

// ── Network ─────────────────────────────────────────────────────────────────

/**
 * @param {DockerClient} docker
 */
async function ensureScanNetwork(docker) {
    try {
        await docker.getNetwork(SCAN_NETWORK).inspect();
        return;
    } catch (err) {
        if (statusCodeOf(err) !== 404) throw err;
    }
    await docker.createNetwork({ Name: SCAN_NETWORK, Driver: 'bridge' });
}

/**
 * The control network: Internal (no gateway, no egress), and only the API
 * server and the ZAP relays join it. Scanners and the toolbox never do.
 * @param {DockerClient} docker
 */
async function ensureControlNetwork(docker) {
    try {
        await docker.getNetwork(CONTROL_NETWORK).inspect();
        return;
    } catch (err) {
        if (statusCodeOf(err) !== 404) throw err;
    }
    await docker.createNetwork({ Name: CONTROL_NETWORK, Driver: 'bridge', Internal: true });
}

/** Inside docker the hostname is the container id. */
function selfContainerId() {
    return process.env.HOSTNAME || require('os').hostname();
}

/**
 * Wire the API server's own container for a toolbox: join CONTROL_NETWORK
 * (to reach the relays) and leave SCAN_NETWORK, which an older version of this
 * module joined. Both are idempotent; "already connected" and "not connected"
 * are success. Only meaningful in the in-container case.
 * @param {DockerClient} docker
 */
async function wireSelfForControl(docker) {
    const self = selfContainerId();
    try { await docker.getNetwork(CONTROL_NETWORK).connect({ Container: self }); } catch (_) { /* already connected */ }
    try { await docker.getNetwork(SCAN_NETWORK).disconnect({ Container: self, Force: true }); } catch (_) { /* not connected */ }
}

/**
 * Start the ZAP control relay for one toolbox: a socat container on
 * CONTROL_NETWORK and SCAN_NETWORK that forwards its port to the toolbox's ZAP
 * port and nothing else. The server reaches ZAP at http://<relay>:<port>
 * without ever sharing a network with the toolbox. Hardened: nobody user,
 * every capability dropped, read-only root, no IP forwarding (so the toolbox
 * cannot route raw packets through it to the control network), small caps.
 * @param {DockerClient} docker
 * @param {{ name: string, target: string, port: number, labels: Record<string, string> }} options
 * @returns {Promise<{ containerId: string, host: string, cleanup: () => Promise<void> }>}
 */
async function startZapRelay(docker, { name, target, port, labels }) {
    if (!(await imageExists(docker, RELAY_IMAGE))) await pullImage(docker, RELAY_IMAGE, null);
    await removeContainerIfExists(docker, name);
    const container = await docker.createContainer({
        name,
        Image: RELAY_IMAGE,
        Cmd: [`TCP-LISTEN:${port},fork,reuseaddr`, `TCP:${target}:${port}`],
        User: '65534:65534',
        Labels: labels,
        ExposedPorts: { [`${port}/tcp`]: {} },
        NetworkingConfig: { EndpointsConfig: { [CONTROL_NETWORK]: {} } },
        HostConfig: {
            NetworkMode: CONTROL_NETWORK,
            Memory: 64 * 1024 * 1024,
            NanoCpus: Math.round(0.25 * 1e9),
            PidsLimit: 64,
            Init: true,
            AutoRemove: false,
            ReadonlyRootfs: true,
            CapDrop: ['ALL'],
            SecurityOpt: ['no-new-privileges'],
            Sysctls: { 'net.ipv4.ip_forward': '0' },
            RestartPolicy: { Name: 'no' },
        },
    });
    let cleaned = false;
    const cleanup = async () => {
        if (cleaned) return; cleaned = true;
        try { await container.stop({ t: 2 }); } catch (_) {}
        try { await container.remove({ force: true }); } catch (_) {}
    };
    try {
        await docker.getNetwork(SCAN_NETWORK).connect({ Container: container.id });
        await container.start();
        return { containerId: container.id, host: `${name}:${port}`, cleanup };
    } catch (e) {
        await cleanup();
        throw e;
    }
}

/**
 * @param {DockerClient} docker
 * @param {string} name
 */
async function removeContainerIfExists(docker, name) {
    try {
        const c = docker.getContainer(name);
        try { await c.stop({ t: 10 }); } catch (_) { /* may be stopped */ }
        await c.remove({ force: true });
    } catch (err) {
        if (statusCodeOf(err) !== 404) throw err;
    }
}

// ── Log streaming ─────────────────────────────────────────────────────────

/**
 * Follow a container's combined stdout/stderr, splitting into trimmed lines and
 * invoking onLine per line. Returns a function that detaches the stream.
 * Uses demuxStream so the 8-byte multiplex headers never corrupt a line.
 * @param {DockerClient} docker
 * @param {DockerContainer} container
 * @param {LineSink} onLine
 * @returns {() => void}  detaches the stream
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
    /** @type {import('node:stream').Readable | null} */
    let logStream = null;
    container.logs({ follow: true, stdout: true, stderr: true }, (err, stream) => {
        if (err || !stream) return;
        logStream = stream;
        container.modem.demuxStream(stream, sink, sink);
    });
    return () => { try { logStream?.destroy(); } catch (_) {} };
}

// ── Engine descriptors ──────────────────────────────────────────────────────

/**
 * Translate an engine descriptor into the container's mount + Cmd. Each engine
 * writes its report into the bind-mounted workdir (always landing at
 * workdir/report.json on the host); the worker reads it back after we return.
 *
 *   • zap     — workdir → /zap/wrk:rw; zap-baseline.py / zap-full-scan.py emit
 *               report.{json,html,xml,md} into the working dir.
 *   • nuclei  — workdir → /out:rw; -je writes JSON export to /out/report.json.
 *   • testssl — workdir → /out:rw; --jsonfile writes /out/report.json.
 * @param {string} engine
 * @param {string | undefined} intensity
 * @param {string} targetUrl
 * @returns {{ bind: string, Cmd: string[] }}
 */
function engineSpec(engine, intensity, targetUrl) {
    switch (engine) {
        case 'zap': {
            const script = intensity === 'full' ? 'zap-full-scan.py' : 'zap-baseline.py';
            return {
                bind: '/zap/wrk:rw',
                Cmd: [script, '-t', targetUrl, '-J', 'report.json', '-r', 'report.html', '-x', 'report.xml', '-w', 'report.md'],
            };
        }
        case 'nuclei':
            return {
                bind: '/out:rw',
                Cmd: ['-u', targetUrl, '-je', '/out/report.json', '-silent'],
            };
        case 'testssl':
            return {
                bind: '/out:rw',
                Cmd: ['--jsonfile', '/out/report.json', '--quiet', targetUrl],
            };
        default:
            throw new Error(`unknown scanner engine: ${engine}`);
    }
}

/**
 * Run a single scanner engine to completion in a throwaway container. The
 * `workdir` host path is bind-mounted at the engine's expected report dir;
 * after this resolves the report lands at `workdir/report.json` (and, for ZAP,
 * the .html/.xml/.md siblings) for the worker to read. Streams output via
 * onLine. Resolves with { exitCode, timedOut } after the container exits or the
 * timeout fires. The container is ALWAYS removed before returning.
 *
 * This function deliberately does NOT read the report — the worker owns report
 * parsing so this module stays a thin docker lifecycle layer.
 * @param {{ scanId: string, engine: string, intensity?: string, workdir: string, targetUrl: string, onLine?: LineSink, timeoutMs?: number }} options
 * @returns {Promise<{ exitCode: number, timedOut: boolean }>}
 */
async function runEngineContainer({ scanId, engine, intensity, workdir, targetUrl, onLine, timeoutMs }) {
    const docker = getDocker();
    const image = await resolveScanImage(engine, onLine);
    await ensureScanNetwork(docker);
    const spec = engineSpec(engine, intensity, targetUrl);
    const name = containerName(scanId, engine);
    await removeContainerIfExists(docker, name);

    const container = await docker.createContainer({
        name,
        Image: image,
        Cmd: spec.Cmd,
        Labels: runnerLabels(scanId),
        HostConfig: hostConfigCaps({
            Binds: [`${workdir}:${spec.bind}`],
            NetworkMode: SCAN_NETWORK,
        }),
        NetworkingConfig: { EndpointsConfig: { [SCAN_NETWORK]: {} } },
    });

    let timedOut = false;
    let killTimer = null;
    const detach = followLogs(docker, container, onLine);
    try {
        await container.start();
        if (timeoutMs && timeoutMs > 0) {
            killTimer = setTimeout(() => {
                timedOut = true;
                // ZAP needs a moment to flush its report on SIGTERM — give it a
                // generous grace period before the hard kill.
                container.stop({ t: 10 }).catch(() => container.kill().catch(() => {}));
            }, timeoutMs);
            killTimer.unref?.();
        }
        const status = await container.wait();
        return { exitCode: timedOut ? 124 : (status?.StatusCode ?? 1), timedOut };
    } finally {
        if (killTimer) clearTimeout(killTimer);
        detach();
        try { await container.remove({ force: true }); } catch (_) { /* reaper backstop */ }
    }
}

// ── Cancellation + reaping ──────────────────────────────────────────────────

/**
 * Tear down every engine container for a scan. Used by the worker's cancel
 * poll — a scan may have several engine containers in flight, so we remove all
 * of this scan's containers by label rather than by a single name.
 * @param {unknown} scanId
 */
async function killScan(scanId) {
    // Adopted (pre-warmed) containers are labeled bf.prewarm, NOT bf.scanId, so
    // the label filter below would miss them — clean up via the registry first.
    const adopted = _activeToolboxes.get(String(scanId));
    if (adopted) {
        _activeToolboxes.delete(String(scanId));
        try { await adopted.cleanup(); } catch (_) {}
    }
    try {
        const docker = getDocker();
        const containers = await docker.listContainers({
            all: true,
            filters: { label: [`${LABEL_SCAN}=${String(scanId)}`] },
        });
        for (const c of containers) {
            try {
                const cont = docker.getContainer(c.Id);
                try { await cont.stop({ t: 10 }); } catch (_) {}
                await cont.remove({ force: true });
            } catch (_) { /* already gone */ }
        }
    } catch (_) { /* ignore */ }
}

/**
 * Remove scanner containers that are orphaned: stopped/exited, or older than
 * MAX_AGE_MS, or whose scan is no longer active. Run on worker boot (kills
 * leftovers from a crashed worker) and on an interval. `isScanActive` lets the
 * caller consult the DB so we don't reap a container whose scan is mid-flight.
 * @param {((scanId: string) => Promise<boolean>) | null} [isScanActive]
 * @returns {Promise<{ reaped: number }>}
 */
async function reapStaleRunners(isScanActive = null) {
    if (!(await dockerAvailable())) return { reaped: 0 };
    let reaped = 0;
    try {
        const docker = getDocker();
        const containers = await docker.listContainers({
            all: true,
            filters: { label: [`${LABEL_KIND}=${LABEL_KIND_VALUE}`] },
        });
        // Never reap a container that's actively driving a scan right now (cold
        // or adopted) — these are tracked in-process by containerId.
        const activeIds = new Set();
        for (const h of _activeToolboxes.values()) {
            if (h?.containerId) activeIds.add(h.containerId);
            if (h?.relayContainerId) activeIds.add(h.relayContainerId);
        }
        const now = Date.now();
        for (const c of containers) {
            if (activeIds.has(c.Id)) continue;
            const scanId = c.Labels?.[LABEL_SCAN];
            const isPrewarm = !!c.Labels?.[LABEL_PREWARM];
            const born = parseInt(c.Labels?.[LABEL_BORN] || '0', 10);
            const exited = c.State === 'exited' || c.State === 'dead' || c.State === 'created';
            const tooOld = born > 0 && (now - born) > MAX_AGE_MS;
            // Backstop for warm containers orphaned by a process restart (the
            // in-memory TTL sweep handles the normal case).
            const prewarmOrphan = isPrewarm && born > 0 && (now - born) > PREWARM_BACKSTOP_MS;
            let inactive = false;
            if (isScanActive && scanId) {
                try { inactive = !(await isScanActive(scanId)); } catch (_) { inactive = false; }
            }
            if (exited || tooOld || inactive || prewarmOrphan) {
                try {
                    const cont = docker.getContainer(c.Id);
                    try { await cont.stop({ t: 10 }); } catch (_) {}
                    await cont.remove({ force: true });
                    reaped++;
                } catch (_) { /* already gone */ }
            }
        }
    } catch (e) {
        console.warn('[ScanRunner] reap failed:', errMessage(e));
    }
    return { reaped };
}

// ── Agent mode: long-lived ZAP daemon + free-form tools sandbox ─────────────

/**
 * Resolve the free-form tools sandbox image (SECURITY_TOOLS_IMAGE, default a
 * locally-built tag). Use it if present locally; otherwise try a registry pull;
 * otherwise fail loudly with the build command. Cached after first success.
 * @type {string | null}
 */
let _toolsImageResolved = null;
/**
 * @param {LineSink} [onLine]
 * @returns {Promise<string>}
 */
async function resolveToolsImage(onLine) {
    if (_toolsImageResolved) return _toolsImageResolved;
    const docker = getDocker();
    if (await imageExists(docker, TOOLS_IMAGE)) { _toolsImageResolved = TOOLS_IMAGE; return TOOLS_IMAGE; }
    try {
        await pullImage(docker, TOOLS_IMAGE, onLine);
    } catch (e) {
        throw new Error(`security tools image '${TOOLS_IMAGE}' not found locally and pull failed (${errMessage(e)}). Build it: docker build -t ${TOOLS_IMAGE} server/terminal-runner`);
    }
    _toolsImageResolved = TOOLS_IMAGE;
    return TOOLS_IMAGE;
}

/**
 * @param {string} baseUrl
 * @param {string} apiKey
 * @param {number} timeoutMs
 * @returns {Promise<true>}
 */
async function _awaitDaemonReady(baseUrl, apiKey, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let lastErr = 'timeout';
    // The daemon requires its api.key on every request (views included), so the
    // readiness probe must carry it too — otherwise ZAP answers 4xx forever.
    const url = `${baseUrl}/JSON/core/view/version/?apikey=${encodeURIComponent(apiKey)}`;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
            if (res.ok) return true;
            lastErr = `HTTP ${res.status}`;
        } catch (e) { lastErr = errMessage(e); }
        await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`ZAP daemon not ready within ${timeoutMs}ms (${lastErr})`);
}

// ── Agent mode: ONE container with the full arsenal + an in-container ZAP ────
//
// The security agent drives a SINGLE long-lived container (the Kali toolbox
// image) that holds every scanner tool AND runs the OWASP ZAP daemon as a
// backgrounded process inside itself. runEngineContainer remains only for a
// legacy quick path.
//
// Raw sockets: nmap -sS / masscan need CAP_NET_RAW. Because no-new-privileges
// blocks non-root file-capability elevation, the only reliable way to let those
// tools use raw sockets is to run the container as root with EVERY capability
// DROPPED except NET_RAW (+ NET_BIND_SERVICE). That is still a tightly-bounded
// process: egress-only network without the API server on it, no docker socket, all-but-NET_RAW
// dropped, no-new-privileges, and cpu/mem/pid caps. Gated by
// SECURITY_TOOLBOX_NET_RAW (default ON); when off, the container runs as the
// unprivileged `scanner` user and nmap degrades to TCP-connect (-sT).
const TOOLBOX_MEMORY_MB = parseInt(process.env.SECURITY_TOOLBOX_MEMORY_MB || '2048', 10);
const TOOLBOX_CPUS = parseFloat(process.env.SECURITY_TOOLBOX_CPUS || '1.0');
const toolboxNetRaw = () => process.env.SECURITY_TOOLBOX_NET_RAW !== 'false';
const ZAP_PORT = 8080;

/**
 * @param {import('dockerode').HostConfig} [extra]
 * @returns {import('dockerode').HostConfig}
 */
function toolboxHostConfig(extra = {}) {
    /** @type {import('dockerode').HostConfig} */
    const cfg = {
        Memory: Math.max(512, TOOLBOX_MEMORY_MB) * 1024 * 1024,
        NanoCpus: Math.round(Math.max(0.5, TOOLBOX_CPUS) * 1e9),
        PidsLimit: 1024,
        Init: true,
        AutoRemove: false,
        SecurityOpt: ['no-new-privileges'],
        RestartPolicy: { Name: 'no' },
        ...extra,
    };
    if (toolboxNetRaw()) {
        cfg.CapDrop = ['ALL'];
        cfg.CapAdd = ['NET_RAW', 'NET_BIND_SERVICE'];
    }
    return cfg;
}

/**
 * Build the per-container exec closure the agent runs shell commands through.
 * exec(command,{onChunk,timeoutMs}) ->
 * { exitCode, timedOut }, streaming stdout/stderr to onChunk({ stream, chunk }).
 * Uses `bash -c` (NOT a login shell) so the image's ENV PATH — which includes
 * /opt/pd/bin and /opt/venv/bin — is inherited intact rather than reset by
 * /etc/profile.
 * @param {DockerContainer} container
 * @returns {ExecFn}
 */
function makeContainerExec(container) {
    return async (command, { onChunk, timeoutMs = 30000 } = {}) => {
        const { Writable } = require('stream');
        const ex = await container.exec({
            Cmd: ['bash', '-c', command],
            AttachStdout: true, AttachStderr: true, Tty: false,
        });
        const stream = await ex.start({ hijack: true, stdin: false });
        /** @param {'stdout' | 'stderr'} tag */
        const mk = (tag) => new Writable({
            write(chunk, _enc, cb) {
                try { onChunk && onChunk({ stream: tag, chunk: chunk.toString('utf8') }); } catch (_) {}
                cb();
            },
        });
        container.modem.demuxStream(stream, mk('stdout'), mk('stderr'));

        let timedOut = false;
        const done = new Promise((resolve) => { stream.on('end', resolve); stream.on('close', resolve); });
        let timer = null;
        const to = new Promise((resolve) => {
            timer = setTimeout(() => { timedOut = true; try { stream.destroy(); } catch (_) {} resolve(undefined); }, Math.max(1000, timeoutMs));
            timer.unref?.();
        });
        await Promise.race([done, to]);
        if (timer) clearTimeout(timer);

        let exitCode = timedOut ? 124 : 0;
        try {
            const info = await ex.inspect();
            if (!timedOut && typeof info.ExitCode === 'number') exitCode = info.ExitCode;
        } catch (_) { /* exec gone */ }
        return { exitCode, timedOut };
    };
}

// Build the ZAP daemon launch command. The proxy/API MUST bind to 0.0.0.0 via
// the `network` add-on — ZAP 2.12+ ignores the legacy `-host` flag and would
// otherwise listen on 127.0.0.1 only, so the worker (reaching the container by
// its network IP/name) gets ECONNREFUSED. `-silent` skips the update-check and
// callhome/telemetry for a faster, deterministic boot on the isolated network.
/**
 * @param {string} apiKey
 * @returns {string}
 */
function _zapDaemonCmd(apiKey) {
    return [
        'zaproxy', '-daemon', '-silent',
        '-host', '0.0.0.0', '-port', String(ZAP_PORT),
        '-dir', '/home/scanner/work/.zap',
        '-config', `network.localServers.mainProxy.address=0.0.0.0`,
        '-config', `network.localServers.mainProxy.port=${ZAP_PORT}`,
        '-config', `api.key=${apiKey}`,
        '-config', 'api.addrs.addr.name=.*',
        '-config', 'api.addrs.addr.regex=true',
    ].join(' ');
}

/**
 * Create + start one toolbox container and launch the in-container ZAP daemon,
 * WITHOUT waiting for ZAP readiness. Returns { handle, cleanup, awaitReady }:
 *   • handle      — { zap:{baseUrl,apiKey}, containerId, exec, cleanup }
 *   • cleanup     — stop+remove the container (usable mid-boot, e.g. to release
 *                   a pre-warm container before ZAP has finished booting)
 *   • awaitReady  — () => Promise<handle> that resolves once ZAP answers.
 * Splitting create from await-ready is what lets pre-warm boot in the
 * background and lets a release tear the container down mid-boot.
 * @param {{ name: string, apiKey: string, labels: Record<string, string>, onLine?: LineSink }} options
 * @returns {Promise<{ handle: ToolboxHandle, cleanup: () => Promise<void>, awaitReady: () => Promise<ToolboxHandle> }>}
 */
async function _spawnToolbox({ name, apiKey, labels, onLine }) {
    const docker = getDocker();
    const image = await resolveToolsImage(onLine);
    await ensureScanNetwork(docker);
    const inContainer = isServerInContainer();
    if (inContainer) {
        await ensureControlNetwork(docker);
        await wireSelfForControl(docker);
    }
    await removeContainerIfExists(docker, name);

    /** @type {import('dockerode').HostConfig} */
    const hostExtra = { NetworkMode: SCAN_NETWORK };
    if (!inContainer) hostExtra.PortBindings = { [`${ZAP_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: '0' }] };

    /** @type {import('dockerode').ContainerCreateOptions} */
    const createOpts = {
        name, Image: image,
        Cmd: ['sleep', 'infinity'], // idle; ZAP + agent commands arrive via exec
        // HOME keeps both ZAP (~/.ZAP) and nuclei (baked templates) pointed at
        // the scanner home even when the container runs as root for NET_RAW.
        Env: ['HOME=/home/scanner'],
        Labels: labels,
        ExposedPorts: { [`${ZAP_PORT}/tcp`]: {} },
        NetworkingConfig: { EndpointsConfig: { [SCAN_NETWORK]: {} } },
        HostConfig: toolboxHostConfig(hostExtra),
    };
    // Raw-socket tooling needs root + NET_RAW (see toolboxHostConfig); without
    // the cap we stay as the image's non-root `scanner` user.
    if (toolboxNetRaw()) createOpts.User = '0';

    const container = await docker.createContainer(createOpts);

    let detach = () => {};
    let cleaned = false;
    /** @type {{ containerId: string, host: string, cleanup: () => Promise<void> } | null} */
    let relay = null;
    const cleanup = async () => {
        if (cleaned) return; cleaned = true;
        try { detach(); } catch (_) {}
        if (relay) { try { await relay.cleanup(); } catch (_) {} }
        try { await container.stop({ t: 5 }); } catch (_) {}
        try { await container.remove({ force: true }); } catch (_) {}
    };

    try {
        await container.start();
        detach = followLogs(docker, container, (line) => { if (onLine) onLine(line); });

        // Launch ZAP as a backgrounded process; setsid+nohup detach it from the
        // exec session so it survives. Output goes to the workdir.
        const zapCmd = _zapDaemonCmd(apiKey);
        const zapExec = await container.exec({
            Cmd: ['bash', '-c', `mkdir -p /home/scanner/work/.zap && setsid nohup ${zapCmd} >/home/scanner/work/zap.log 2>&1 & echo zap-launched`],
            AttachStdout: true, AttachStderr: true, Tty: false,
        });
        try {
            const zs = await zapExec.start({ hijack: true, stdin: false });
            zs.on('data', () => {}); // drain; ZAP keeps running via setsid+nohup
            zs.on('error', () => {});
        } catch (_) { /* the readiness poll is the real synchronization */ }

        let host;
        if (inContainer) {
            // The server is not on SCAN_NETWORK: it reaches ZAP via the relay.
            relay = await startZapRelay(docker, { name: `${name}-zrelay`, target: name, port: ZAP_PORT, labels });
            host = relay.host;
        } else {
            const info = await container.inspect();
            const hp = info?.NetworkSettings?.Ports?.[`${ZAP_PORT}/tcp`]?.[0]?.HostPort;
            if (!hp) throw new Error('toolbox did not publish a host port for ZAP');
            host = `127.0.0.1:${hp}`;
        }
        const baseUrl = `http://${host}`;
        /** @type {ToolboxHandle} */
        const handle = {
            zap: { baseUrl, apiKey },
            containerId: container.id,
            relayContainerId: relay ? relay.containerId : null,
            exec: makeContainerExec(container),
            cleanup,
        };
        const awaitReady = async () => {
            await _awaitDaemonReady(baseUrl, apiKey, ZAP_BOOT_TIMEOUT_MS);
            return handle;
        };
        return { handle, cleanup, awaitReady };
    } catch (e) {
        await cleanup();
        throw e;
    }
}

/**
 * Cold path: start one toolbox + ZAP for a scan and wait until ZAP is ready.
 * The container carries the bf.scanId label so killScan()/reapStaleRunners()
 * tear it down too; callers MUST also cleanup() in finally.
 * @param {{ scanId: string, onLine?: LineSink }} options
 * @returns {Promise<ToolboxHandle>}
 */
async function startAgentToolbox({ scanId, onLine }) {
    const apiKey = crypto.randomBytes(24).toString('hex'); // per-scan; never logged
    const name = containerName(scanId, 'agent');
    const spawned = await _spawnToolbox({ name, apiKey, labels: runnerLabels(scanId), onLine });
    try {
        return await spawned.awaitReady();
    } catch (e) {
        await spawned.cleanup();
        throw e;
    }
}

// ── Pre-warm: boot a toolbox in the background so a scan starts instantly ────
//
// When the user opens the New-scan dialog the route pre-warms a toolbox; by the
// time they submit it's booted and the worker ADOPTS it. Single-use: the
// adopted container is destroyed after the scan (no cross-scan reuse, so no
// session reset needed). Best-effort everywhere — if anything fails the worker
// just cold-starts.
/**
 * A toolbox being warmed in the background for a user who has not submitted the scan yet.
 * @typedef {object} PrewarmEntry
 * @property {Promise<ToolboxHandle>} promise
 * @property {(() => Promise<void>) | null} cleanup  set once the container exists
 * @property {string | null} userId
 * @property {number} createdAt
 * @property {'warming' | 'ready' | 'failed'} state
 * @property {boolean} claimed
 * @property {boolean} released
 */

/** @type {Map<string, PrewarmEntry>} */
const _prewarmRegistry = new Map();
/** @type {Map<string, ToolboxHandle>} scanId -> handle (cold OR adopted) for cancel/reap */
const _activeToolboxes = new Map();

/**
 * Start warming a toolbox in the background; returns a prewarmId immediately.
 * @param {{ userId?: string | null }} [options]
 * @returns {string}  the prewarm id
 */
function prewarmToolbox({ userId = null } = {}) {
    // One unclaimed warm container per user — release the previous one.
    for (const [pid, e] of _prewarmRegistry) {
        if (e.userId === userId && !e.claimed) _releasePrewarmEntry(pid).catch(() => {});
    }
    const prewarmId = crypto.randomBytes(12).toString('hex');
    const apiKey = crypto.randomBytes(24).toString('hex');
    const name = containerName(prewarmId, 'warm');
    const labels = {
        [LABEL_KIND]: LABEL_KIND_VALUE,
        [LABEL_PREWARM]: prewarmId,
        [LABEL_BORN]: String(Date.now()),
    };
    // `promise` is filled in on the next line: the warm-up closure below reads `entry`.
    const entry = /** @type {PrewarmEntry} */ ({ userId, createdAt: Date.now(), state: 'warming', claimed: false, released: false, cleanup: null });
    entry.promise = (async () => {
        const spawned = await _spawnToolbox({ name, apiKey, labels, onLine: null });
        entry.cleanup = spawned.cleanup;
        if (entry.released) { await spawned.cleanup(); throw new Error('prewarm_released'); }
        try {
            const handle = await spawned.awaitReady();
            if (entry.released) { await spawned.cleanup(); throw new Error('prewarm_released'); }
            entry.state = 'ready';
            return handle;
        } catch (e) {
            entry.state = 'failed';
            await spawned.cleanup();
            throw e;
        }
    })();
    entry.promise.catch(() => {}); // avoid unhandledRejection; adopt/release handle errors
    _prewarmRegistry.set(prewarmId, entry);
    return prewarmId;
}

/**
 * A warm toolbox belongs to the user who warmed it; nobody else may adopt or
 * release it (a prewarm id is not a secret: it travels in scan metadata).
 * @param {PrewarmEntry} entry
 * @param {unknown} userId
 */
function _ownsPrewarm(entry, userId) {
    return entry.userId != null && userId != null && String(entry.userId) === String(userId);
}

/**
 * Adopt a warm toolbox (awaiting the remainder of its boot). null → cold-start.
 * Only the user who warmed it may adopt it; anyone else gets null and the warm
 * container stays with its owner.
 * @param {string} prewarmId
 * @param {unknown} userId  the scan's owner
 * @returns {Promise<ToolboxHandle | null>}
 */
async function adoptToolbox(prewarmId, userId) {
    const entry = prewarmId ? _prewarmRegistry.get(prewarmId) : null;
    if (!entry || entry.released) return null;
    if (!_ownsPrewarm(entry, userId)) return null;
    entry.claimed = true;
    _prewarmRegistry.delete(prewarmId);
    try { return await entry.promise; }
    catch (_) { return null; }
}

/**
 * Tear down an unclaimed warm toolbox (e.g. dialog closed without submitting).
 * Only its owner may release it. Returns whether it was released.
 * @param {string} prewarmId
 * @param {unknown} userId  the caller
 * @returns {Promise<boolean>}
 */
async function releasePrewarm(prewarmId, userId) {
    const entry = prewarmId ? _prewarmRegistry.get(prewarmId) : null;
    if (!entry || !_ownsPrewarm(entry, userId)) return false;
    await _releasePrewarmEntry(prewarmId);
    return true;
}

/**
 * Internal release, no ownership check: the TTL sweep and the one-per-user
 * replacement in prewarmToolbox.
 * @param {string} prewarmId
 */
async function _releasePrewarmEntry(prewarmId) {
    const entry = prewarmId ? _prewarmRegistry.get(prewarmId) : null;
    if (!entry) return;
    _prewarmRegistry.delete(prewarmId);
    entry.released = true;
    // If the container already exists, clean it up now; otherwise the warming
    // promise's `entry.released` check tears it down as soon as it's created.
    if (entry.cleanup) { try { await entry.cleanup(); } catch (_) {} }
}

/** Release unclaimed warm toolboxes past their TTL. Runs on an interval. */
function sweepPrewarmRegistry() {
    const now = Date.now();
    for (const [pid, e] of _prewarmRegistry) {
        if (!e.claimed && (now - e.createdAt) > PREWARM_TTL_MS) {
            _releasePrewarmEntry(pid).catch(() => {});
        }
    }
}
const _prewarmSweep = setInterval(sweepPrewarmRegistry, 60000);
_prewarmSweep.unref?.();

/**
 * Track a live toolbox by scanId so cancel/reap can target it (incl. adopted).
 * @param {unknown} scanId
 * @param {ToolboxHandle} handle
 */
function registerActiveToolbox(scanId, handle) {
    if (scanId && handle) _activeToolboxes.set(String(scanId), handle);
}
/**
 * @param {unknown} scanId
 */
function unregisterActiveToolbox(scanId) {
    if (scanId) _activeToolboxes.delete(String(scanId));
}

// ── Scanner-image provisioning (module Track C) ─────────────────────────────
//
// The ~2-4 GB Kali `beeflow-security-tools` image is NOT bundled in the .bfmod.
// After install a super-admin provisions it ONCE from the Studio Security tab,
// either BUILDING it from the shipped Dockerfile (assets/terminal-runner) or
// PULLING it from a configured registry ref (SECURITY_TOOLS_PULL_REF) and
// retagging to TOOLS_IMAGE. These helpers extend resolveToolsImage's inspect
// logic (imageExists/getDocker/pullImage above) into a probe + a provisioner.
const path = require('path');
const SECURITY_TOOLS_PULL_REF = process.env.SECURITY_TOOLS_PULL_REF || null;

/**
 * Probe what the operator can do with the scanner image right now.
 *   dockerOk  — the docker socket is reachable (a live daemon ping)
 *   imageOk   — TOOLS_IMAGE exists locally (docker.getImage().inspect() ok)
 *   image     — the resolved TOOLS_IMAGE tag
 *   canPull   — a pull ref (SECURITY_TOOLS_PULL_REF) is configured
 *   canBuild  — the shipped Dockerfile asset is present next to the module
 * @param {{ assetsDir?: string | null }} [options]
 */
async function toolboxStatus({ assetsDir = null } = {}) {
    const dockerOk = await dockerAvailable();
    let imageOk = false;
    if (dockerOk) {
        try { imageOk = await imageExists(getDocker(), TOOLS_IMAGE); }
        catch (_) { imageOk = false; }
    }
    let canBuild = false;
    try { canBuild = !!assetsDir && fs.existsSync(path.join(assetsDir, 'Dockerfile')); }
    catch (_) { canBuild = false; }
    return { dockerOk, imageOk, image: TOOLS_IMAGE, canPull: !!SECURITY_TOOLS_PULL_REF, canBuild };
}

// Build a one-file tar (just the Dockerfile) as the docker build context. The
// image bakes its whole arsenal from apt/registry inside the Dockerfile, so the
// context needs nothing else.
/**
 * @param {string} assetsDir
 * @returns {import('tar-stream').Pack}
 */
function _buildContextTar(assetsDir) {
    const tar = require('tar-stream');
    const pack = tar.pack();
    const dockerfile = fs.readFileSync(path.join(assetsDir, 'Dockerfile'));
    pack.entry({ name: 'Dockerfile' }, dockerfile);
    pack.finalize();
    return pack;
}

/**
 * Provision the scanner image. `onEvent` receives the raw dockerode progress
 * events (build: { stream } log lines; pull: { status, progress, id }). Resolves
 * with { imageOk } once the image is present under TOOLS_IMAGE.
 *   • build — docker.buildImage over a tar of assets/terminal-runner, tag TOOLS_IMAGE
 *   • pull  — docker.pull(SECURITY_TOOLS_PULL_REF), then retag to TOOLS_IMAGE
 * @param {{ mode?: string, assetsDir?: string | null, onEvent?: ((event: import('dockerode').ProgressEvent) => void) | null }} [options]
 * @returns {Promise<{ imageOk: boolean }>}
 */
async function provisionToolbox({ mode, assetsDir = null, onEvent = null } = {}) {
    if (!(await dockerAvailable())) throw new Error('docker_unavailable');
    const docker = getDocker();

    if (mode === 'build') {
        if (!assetsDir || !fs.existsSync(path.join(assetsDir, 'Dockerfile'))) {
            throw new Error('dockerfile_missing');
        }
        const context = _buildContextTar(assetsDir);
        const stream = await docker.buildImage(context, { t: TOOLS_IMAGE, dockerfile: 'Dockerfile' });
        await new Promise((resolve, reject) => {
            docker.modem.followProgress(
                stream,
                (err, output) => {
                    if (err) return reject(err);
                    // A build error surfaces as an { errorDetail } event in the
                    // stream rather than a rejected stream — surface it as a failure.
                    const last = Array.isArray(output) ? output[output.length - 1] : null;
                    if (last && last.error) return reject(new Error(String(last.error).slice(0, 500)));
                    resolve(undefined);
                },
                (evt) => { if (onEvent) { try { onEvent(evt); } catch (_) {} } },
            );
        });
    } else if (mode === 'pull') {
        if (!SECURITY_TOOLS_PULL_REF) throw new Error('pull_ref_not_configured');
        await pullImage(docker, SECURITY_TOOLS_PULL_REF, (line) => {
            if (onEvent) { try { onEvent({ status: line }); } catch (_) {} }
        });
        // Retag the pulled ref to the canonical TOOLS_IMAGE the runner looks up.
        if (SECURITY_TOOLS_PULL_REF !== TOOLS_IMAGE) {
            const [repo, tag] = TOOLS_IMAGE.split(':');
            try { await docker.getImage(SECURITY_TOOLS_PULL_REF).tag({ repo, tag: tag || 'latest' }); }
            catch (e) { throw new Error(`retag failed: ${errMessage(e)}`); }
        }
    } else {
        throw new Error(`invalid provision mode: ${mode}`);
    }

    // Invalidate the resolve cache so the next scan re-inspects the fresh image.
    _toolsImageResolved = null;
    const imageOk = await imageExists(getDocker(), TOOLS_IMAGE);
    return { imageOk };
}

module.exports = {
    dockerAvailable,
    isServerInContainer,
    resolveScanImage,
    ensureScanNetwork,
    runEngineContainer,
    killScan,
    reapStaleRunners,
    resolveToolsImage,
    startAgentToolbox,
    prewarmToolbox,
    adoptToolbox,
    releasePrewarm,
    registerActiveToolbox,
    unregisterActiveToolbox,
    SCAN_NETWORK,
    CONTROL_NETWORK,
    PINNED_IMAGES,
    DEFAULT_IMAGES,
    RELAY_IMAGE,
    // module Track C — scanner-image provisioning
    TOOLS_IMAGE,
    toolboxStatus,
    provisionToolbox,
    // Test seams: swap the docker client and the in-container probe.
    __test: {
        /** @param {(() => DockerClient) | null} factory */
        setDocker(factory) { _dockerOverride = factory; },
        /** @param {boolean | null} value */
        setInContainer(value) { _inContainerOverride = value; },
        resetCaches() {
            _toolsImageResolved = null;
            for (const k of Object.keys(_resolvedImages)) delete _resolvedImages[k];
            _prewarmRegistry.clear();
            _activeToolboxes.clear();
        },
    },
};
