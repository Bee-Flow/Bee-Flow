// @typecheck strict
'use strict';
// Split out of guardInstaller.js (file budget): the Redis half of the guard pair.

/**
 * The redis-server arguments of the guard's cache. Not persisted: no RDB
 * snapshots (`--save ''`), no AOF, and no volume. It holds caches only (the
 * PII result cache, which keeps no span text), so a restart costs a few
 * misses, and nothing in it ever reaches a disk.
 */
const REDIS_CMD = Object.freeze([
    'redis-server',
    '--maxmemory', '256mb',
    '--maxmemory-policy', 'allkeys-lru',
    '--save', '',
    '--appendonly', 'no',
]);

/**
 * The guard's Redis cache container, on the guard network, without a volume.
 * @param {import('./docker/dockerKit').DockerClient} docker
 * @param {{ container: string, network: string }} names
 */
async function startRedis(docker, { container: containerName, network }) {
    const container = await docker.createContainer({
        name: containerName,
        Image: 'redis:7-alpine',
        Cmd: [...REDIS_CMD],
        HostConfig: {
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

module.exports = { startRedis, REDIS_CMD };
