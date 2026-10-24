// @typecheck
/**
 * Small Docker helpers shared by the services that start sidecar containers
 * (pwtRunner, guardInstaller, webpageRuntimeManager). Each takes the dockerode
 * client as an argument, so callers keep their own socket and test seams.
 *
 * The hub-module scanRunner keeps its own copy: it is built and shipped
 * separately and cannot require server code.
 */

const fs = require('fs');
const log = require('../../telemetry/log');

/**
 * Detect whether the server itself is running inside a Docker container.
 * - /.dockerenv is created by the docker engine in every container.
 * - Falls back to checking cgroup membership for non-standard runtimes.
 */
function isServerInContainer() {
    try {
        if (fs.existsSync('/.dockerenv')) return true;
    } catch (err) { log.debug('ignore', err); }
    try {
        const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
        return /docker|containerd|kubepods/.test(cgroup);
    } catch (err) { log.debug('not Linux or no /proc — assume native', err); }
    return false;
}

/** True when the image is present locally; a non-404 error propagates. */
async function imageExists(docker, image) {
    try {
        await docker.getImage(image).inspect();
        return true;
    } catch (err) {
        if (err.statusCode === 404) return false;
        throw err;
    }
}

/**
 * Pull an image and resolve when the pull stream finishes. `onProgress`, when
 * given, receives every progress event; throttling and reporting stay with the
 * caller.
 */
function pullImage(docker, image, onProgress) {
    return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        docker.pull(image, (err, stream) => {
            if (err) return reject(err);
            const onFinished = (progressErr) => progressErr ? reject(progressErr) : resolve();
            if (onProgress) docker.modem.followProgress(stream, onFinished, onProgress);
            else docker.modem.followProgress(stream, onFinished);
        });
    }));
}

/** Create a bridge network unless it already exists. */
async function ensureNetwork(docker, name) {
    try {
        await docker.getNetwork(name).inspect();
        return;
    } catch (err) {
        if (err.statusCode !== 404) throw err;
    }
    await docker.createNetwork({ Name: name, Driver: 'bridge' });
}

/**
 * Attach the server's own container (HOSTNAME = container id) to `network` so
 * it can reach a sidecar by name. Idempotent: a 403 ("already exists in
 * network") counts as success. `onError` sees any other failure.
 */
async function connectSelfToNetwork(docker, network, onError) {
    const hostname = process.env.HOSTNAME;
    if (!hostname) return false;
    try {
        await docker.getNetwork(network).connect({ Container: hostname });
        return true;
    } catch (err) {
        if (err.statusCode === 403 || /already exists/i.test(err.message || '')) return true;
        if (onError) onError(err);
        return false;
    }
}

/** Stop (grace `stopTimeoutSec`) and force-remove a container; a 404 is fine. */
async function removeContainerIfExists(docker, name, stopTimeoutSec) {
    try {
        const c = docker.getContainer(name);
        try { await c.stop({ t: stopTimeoutSec }); } catch (err) { log.debug('may already be stopped', err); }
        await c.remove({ force: true });
    } catch (err) {
        if (err.statusCode !== 404) throw err;
    }
}

module.exports = {
    isServerInContainer,
    imageExists,
    pullImage,
    ensureNetwork,
    connectSelfToNetwork,
    removeContainerIfExists,
};
