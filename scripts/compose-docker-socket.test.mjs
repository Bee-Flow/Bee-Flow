/**
 * The Docker socket is an opt-in, never part of the default stacks.
 *
 * Whoever holds /var/run/docker.sock holds the host, and the server is the
 * internet-facing process. The default stacks (the build stack and the
 * registry stack selfhost.sh runs) must not mount it; the override file is the
 * only place it appears, and selfhost.sh layers that file on top only when
 * DOCKER_SOCKET=1. The dev stack is the developer's own machine and keeps it.
 *
 * Run: node --test scripts/compose-docker-socket.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './lib/docker-stub.mjs';

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const SOCKET_MOUNT = /^\s*-\s*["']?\/var\/run\/docker\.sock:/m;
const OVERRIDE = 'docker-compose.docker-socket.override.yml';

test('the default stacks do not mount the Docker socket into the server', () => {
    for (const file of ['docker-compose.yml', 'docker-compose.from-registry.yml']) {
        assert.ok(!SOCKET_MOUNT.test(read(file)), `${file} mounts /var/run/docker.sock; that belongs in ${OVERRIDE}`);
    }
});

test('the override file is the one place the mount lives, on the server service', () => {
    const text = read(OVERRIDE);
    assert.ok(SOCKET_MOUNT.test(text));
    assert.match(text, /^services:\n\s+server:\n\s+volumes:/m);
});

test('selfhost.sh layers the override only on DOCKER_SOCKET=1, and saves the choice', () => {
    const sh = read('selfhost.sh');
    assert.match(sh, /DOCKER_SOCKET="\$\{DOCKER_SOCKET:-0\}"/, 'off by default');
    assert.match(sh, new RegExp(`SOCKET_OVERRIDE="\\$SCRIPT_DIR/${OVERRIDE.replace(/\./g, '\\.')}"`));
    assert.match(sh, /\[ "\$DOCKER_SOCKET" = "1" \] && COMPOSE_FILES\+=\(-f "\$SOCKET_OVERRIDE"\)/);
    assert.ok(!/compose -f "\$COMPOSE_FILE"/.test(sh), 'every compose call goes through COMPOSE_FILES');
    assert.match(sh, /set_env DOCKER_SOCKET/);
});
