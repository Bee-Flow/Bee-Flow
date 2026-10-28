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
const { bestEffort } = require('../../utils/bestEffort');

/**
 * The slice of the dockerode client these helpers use (dockerode ships no usable typings here).
 * @typedef {object} DockerClient
 * @property {(image: string) => { inspect(): Promise<unknown> }} getImage
 * @property {(name: string) => { inspect(): Promise<unknown> }} getVolume
 * @property {(opts: { Name: string }) => Promise<unknown>} createVolume
 * @property {(opts: Record<string, unknown>) => Promise<{ start(): Promise<unknown> }>} createContainer
 * @property {(image: string, callback: (err: Error | null, stream: NodeJS.ReadableStream) => void) => void} pull
 * @property {{ followProgress(stream: NodeJS.ReadableStream, onFinished: (err: Error | null) => void, onProgress?: (event: { status?: string, id?: string }) => void): void }} modem
 */

/**
 * Detect whether the server itself is running inside a Docker container.
 * - /.dockerenv is created by the docker engine in every container.
 * - Falls back to checking cgroup membership for non-standard runtimes.
 */
function isServerInContainer() {
    try {
        if (fs.existsSync('/.dockerenv')) return true;
    } catch (err) { bestEffort('services/docker/dockerKit:isServerInContainer', err); /* ignore */ }
    try {
        const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
        return /docker|containerd|kubepods/.test(cgroup);
    } catch (err) { bestEffort('services/docker/dockerKit:isServerInContainer#2', err); /* not Linux or no /proc — assume native */ }
    return false;
}

/**
 * True when the image is present locally; a non-404 error propagates.
 * @param {DockerClient} docker
 * @param {string} image
 */
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
 * @param {DockerClient} docker
 * @param {string} image
 * @param {(event: { status?: string, id?: string }) => void} [onProgress]
 */
function pullImage(docker, image, onProgress) {
    return /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
        docker.pull(image, (err, stream) => {
            if (err) return reject(err);
            /**
             * @param {Error | null} progressErr
             */
            const onFinished = (progressErr) => progressErr ? reject(progressErr) : resolve();
            if (onProgress) docker.modem.followProgress(stream, onFinished, onProgress);
            else docker.modem.followProgress(stream, onFinished);
        });
    }));
}

/**
 * Create a bridge network unless it already exists.
 * @param {string} name
 */
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
 * @param {string} network
 */
async function connectSelfToNetwork(docker, network, onError) {
    const hostname = process.env.HOSTNAME;
    if (!hostname) return false;
    try {
        await docker.getNetwork(network).connect({ Container: hostname });
        return true;
    } catch (err) {
        if (err.statusCode === 403 || /already exists/i.test(/** @type {Error} */ (err).message || '')) return true;
        if (onError) onError(err);
        return false;
    }
}

/**
 * Stop (grace `stopTimeoutSec`) and force-remove a container; a 404 is fine.
 * @param {string} name
 * @param {number} stopTimeoutSec
 */
async function removeContainerIfExists(docker, name, stopTimeoutSec) {
    try {
        const c = docker.getContainer(name);
        try { await c.stop({ t: stopTimeoutSec }); } catch (err) { bestEffort('services/docker/dockerKit:removeContainerIfExists', err); /* may already be stopped */ }
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
