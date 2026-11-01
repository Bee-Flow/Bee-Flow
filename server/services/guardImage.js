// @typecheck strict
/**
 * Where the guard image comes from (services/guardInstaller.js calls this).
 *
 * resolveGuardImage tries, in order: GUARD_IMAGE, an image a developer or CI
 * already built, the registry (:dev then :latest, or GUARD_IMAGE_TAG), and a
 * build from ./guard-service/Dockerfile. ensureImage pulls one image unless it
 * is already there. Both report through the `setProgress(phase, detail)` the
 * installer passes in, so this module owns no state of its own.
 */

const fs = require('fs');
const path = require('path');
const log = require('../telemetry/log');
const { imageExists, pullImage: pullImageStream } = require('./docker/dockerKit');

/** @typedef {import('./docker/dockerKit').DockerClient} DockerClient */
/** The installer's progress reporter: a phase and what to show for it. */
/** @typedef {(phase: string, detail: { message: string, percent: number | null }) => void} SetProgress */

/**
 * @param {DockerClient} docker
 * @param {string} image
 * @param {string | undefined} displayName
 * @param {SetProgress} setProgress
 */
async function pullImage(docker, image, displayName, setProgress) {
    /** @type {Map<string, { current: number, total: number, done: boolean }>} */
    const layers = new Map(); // id → { current, total, done }
    let lastReport = 0;

    await pullImageStream(docker, image, (evt) => {
        if (!evt) return;
        const id = evt.id;
        if (id && evt.progressDetail && typeof evt.progressDetail.total === 'number' && evt.progressDetail.total > 0) {
            layers.set(id, {
                current: evt.progressDetail.current || 0,
                total: evt.progressDetail.total,
                done: false,
            });
        }
        // Layer completion signals — treat the layer as fully downloaded
        // so percent reaches 100 even if the last progress event was lost.
        if (id && /complete/i.test(evt.status || '')) {
            const layer = layers.get(id);
            if (layer) {
                layers.set(id, { ...layer, current: layer.total, done: true });
            }
        }

        // Throttle progress writes to ~3/sec so the polling
        // endpoint doesn't see flicker and we don't spin the CPU.
        const now = Date.now();
        if (now - lastReport < 300) return;
        lastReport = now;

        let current = 0;
        let total = 0;
        for (const layer of layers.values()) {
            current += layer.current;
            total += layer.total;
        }
        const percent = total > 0 ? (current / total) * 100 : null;
        setProgress('pull', {
            message: `Pulling ${displayName || image}`,
            percent,
        });
    });

    // Ensure a clean 100% on completion (the last event may have been a
    // "Pull complete" without numeric detail).
    setProgress('pull', { message: `Pulled ${displayName || image}`, percent: 100 });
}

/**
 * @param {DockerClient} docker
 * @param {string} image
 * @param {string | undefined} displayName
 * @param {SetProgress} setProgress
 */
async function ensureImage(docker, image, displayName, setProgress) {
    if (await imageExists(docker, image)) return;
    await pullImage(docker, image, displayName, setProgress);
}

/**
 * Build the guard image from the local Dockerfile shipped with the repo.
 * Used when no prebuilt image is available locally and the registry tag
 * cannot be pulled (e.g. local dev without GHCR access).
 * @param {DockerClient} _docker  the build goes through the docker CLI, not the client
 * @param {string} image
 * @param {SetProgress} setProgress
 */
async function buildGuardImage(_docker, image, setProgress) {
    // Candidate context dirs reachable from inside the server process:
    //   /guard-service              — bind-mount used by docker-compose.dev.yml
    //   <repo-root>/guard-service   — when the server runs natively
    // First match wins.
    const candidates = [
        '/guard-service',
        path.resolve(__dirname, '..', '..', 'guard-service'),
    ];
    const contextDir = candidates.find(c => fs.existsSync(path.join(c, 'Dockerfile')));
    if (!contextDir) {
        throw new Error(`guard-service Dockerfile not found (looked in: ${candidates.join(', ')})`);
    }
    log.info(`[GuardInstaller] Building ${image} from ${contextDir} (this can take several minutes on first run)`);

    // Stream `docker build` output line-by-line so we can report progress.
    // The classic builder emits "Step N/M : <directive>"; buildkit emits
    // "#N [stage] step" headers — we recognise both, but coarse-percent
    // tracking is only meaningful for the classic case. With buildkit we
    // just surface the last step header as the message.
    //
    // We force the classic builder (DOCKER_BUILDKIT=0) so the Step-N/M
    // signal is reliable. Builds work fine either way for this image.
    const { spawn } = require('child_process');
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        const proc = spawn('docker', ['build', '-t', image, contextDir], {
            env: { ...process.env, DOCKER_BUILDKIT: '0' },
        });

        let stderrTail = '';
        let lastReport = 0;
        const STEP_RE = /^Step (\d+)\/(\d+)\s*:\s*(.*)$/;

        /** @param {string} line */
        const handleLine = (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            const m = STEP_RE.exec(trimmed);
            if (m) {
                const step = Number(m[1]);
                const total = Number(m[2]);
                const directive = m[3].slice(0, 80);
                const now = Date.now();
                if (now - lastReport >= 300) {
                    lastReport = now;
                    setProgress('build', {
                        message: `Building (${step}/${total}): ${directive}`,
                        percent: (step / total) * 100,
                    });
                }
            }
        };

        let stdoutBuf = '';
        proc.stdout.on('data', (/** @type {Buffer | string} */ chunk) => {
            stdoutBuf += chunk.toString();
            let idx;
            while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
                handleLine(stdoutBuf.slice(0, idx));
                stdoutBuf = stdoutBuf.slice(idx + 1);
            }
        });

        proc.stderr.on('data', (/** @type {Buffer | string} */ chunk) => {
            const s = chunk.toString();
            stderrTail = (stderrTail + s).slice(-4000); // keep last 4 KB for error reporting
            // buildkit headers (when DOCKER_BUILDKIT couldn't be turned off) land on stderr
            for (const line of s.split('\n')) handleLine(line);
        });

        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) {
                setProgress('build', { message: `Built ${image}`, percent: 100 });
                resolve();
            } else {
                reject(new Error(`docker build exited with code ${code}\n${stderrTail}`));
            }
        });
    }));
}

/**
 * Resolve which guard image to use. Tries, in order:
 *   1. process.env.GUARD_IMAGE (explicit override)
 *   2. locally present images matching common dev/compose tags
 *   3. ghcr.io registry pull (production default)
 *   4. local build from ./guard-service/Dockerfile
 * Returns the image reference that was successfully made available locally.
 * @param {DockerClient} docker
 * @param {SetProgress} setProgress
 * @returns {Promise<string>}
 */
async function resolveGuardImage(docker, setProgress) {
    if (process.env.GUARD_IMAGE) {
        await ensureImage(docker, process.env.GUARD_IMAGE, undefined, setProgress);
        return process.env.GUARD_IMAGE;
    }

    // Candidates a local developer or CI might have already built.
    const localCandidates = [
        'beeflow-guard:latest',
        'bee-flow-ai-guard-service:latest',
        'bee-flow-ai_guard-service:latest',
    ];
    for (const tag of localCandidates) {
        if (await imageExists(docker, tag)) return tag;
    }

    // Try the registry. :dev is published by the CI workflow on every push to
    // main that touches guard-service/; :latest is the explicit prod release
    // tag. Honour an explicit GUARD_IMAGE_TAG when set.
    const tagChain = process.env.GUARD_IMAGE_TAG
        ? [process.env.GUARD_IMAGE_TAG]
        : ['dev', 'latest'];
    /** @type {Error | null} */
    let lastPullErr = null;
    for (const tag of tagChain) {
        const registryImage = `ghcr.io/bee-flow/guard:${tag}`;
        try {
            await ensureImage(docker, registryImage, undefined, setProgress);
            return registryImage;
        } catch (pullErr) {
            lastPullErr = /** @type {Error} */ (pullErr);
            log.warn(`[GuardInstaller] Registry pull ${registryImage} failed: ${lastPullErr.message}`);
        }
    }

    // Last resort: build from the Dockerfile shipped with the repo. This works
    // when ./guard-service is reachable from inside the server process — either
    // because the server runs natively, or because docker-compose.dev.yml
    // bind-mounts ./guard-service into the container.
    const buildContextExists = fs.existsSync('/guard-service/Dockerfile')
        || fs.existsSync(path.resolve(__dirname, '..', '..', 'guard-service', 'Dockerfile'));
    if (!buildContextExists) {
        throw new Error(
            'Could not pull ghcr.io/bee-flow/guard (:dev or :latest) and the '
            + 'guard-service build context is not reachable. '
            + 'In dev compose, ensure ./guard-service is bind-mounted into the '
            + 'server container (see docker-compose.dev.yml) and restart with '
            + '`docker compose -f docker-compose.dev.yml up -d`. '
            + 'Otherwise set GUARD_IMAGE to a reachable image. '
            + (lastPullErr ? `(last pull error: ${lastPullErr.message})` : '')
        );
    }
    const buildTag = 'beeflow-guard:local';
    await buildGuardImage(docker, buildTag, setProgress);
    return buildTag;
}

module.exports = { ensureImage, resolveGuardImage };
