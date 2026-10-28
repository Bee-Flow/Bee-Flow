// @typecheck strict
'use strict';
// Split out of guardInstaller.js (file budget): the Redis half of the guard pair.

/**
 * @param {import('./docker/dockerKit').DockerClient} docker
 * @param {string} name
 */
async function ensureVolume(docker, name) {
    try {
        await docker.getVolume(name).inspect();
        return;
    } catch (err) {
        if (err.statusCode !== 404) throw err;
    }
    await docker.createVolume({ Name: name });
}

/**
 * The guard's Redis cache container, on the guard network, with its own volume.
 * @param {import('./docker/dockerKit').DockerClient} docker
 * @param {{ container: string, volume: string, network: string }} names
 */
async function startRedis(docker, { container: containerName, volume, network }) {
    await ensureVolume(docker, volume);
    const container = await docker.createContainer({
        name: containerName,
        Image: 'redis:7-alpine',
        Cmd: ['redis-server', '--maxmemory', '256mb', '--maxmemory-policy', 'allkeys-lru'],
        HostConfig: {
            Binds: [`${volume}:/data`],
            RestartPolicy: { Name: 'unless-stopped' },
            NetworkMode: network,
        },
        NetworkingConfig: {
            EndpointsConfig: { [network]: { Aliases: [containerName] } },
        },
        Healthcheck: {
            Test: ['CMD', 'redis-cli', 'ping'],
            Interval: 10_000_000_000,
            Timeout: 5_000_000_000,
            Retries: 3,
        },
    });
    await container.start();
}

module.exports = { startRedis, ensureVolume };
