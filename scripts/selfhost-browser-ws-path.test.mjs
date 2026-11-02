/**
 * selfhost.sh fills BROWSER_WS_PATH in an existing .env before any compose call.
 *
 * The compose files require BROWSER_WS_PATH (`${BROWSER_WS_PATH:?...}`), and
 * Compose interpolates the whole file for every command, so a .env from before
 * that requirement would make --stop / --down / --logs fail as well as up.
 * selfhost.sh runs against a fake `docker` in a scratch directory here.
 *
 * Run: node --test scripts/selfhost-browser-ws-path.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, run, hasBash } from './lib/docker-stub.mjs';

const OLD_ENV = 'TAG=latest\nPROFILES=core\nSESSION_SECRET=abc\n';

/** @param {string} dir */
const envOf = (dir) => fs.readFileSync(path.join(dir, '.env'), 'utf8');

for (const cmd of ['--stop', '--down', '--logs']) {
    test(`${cmd} appends a generated BROWSER_WS_PATH to a .env that lacks it`, { skip: !hasBash }, (t) => {
        const dir = sandbox(t, { scripts: ['selfhost.sh'], files: { '.env': OLD_ENV } });
        const res = run(dir, 'selfhost.sh', [cmd]);
        assert.strictEqual(res.status, 0, res.stderr);
        const env = envOf(dir);
        assert.match(env, /^BROWSER_WS_PATH=[0-9a-f]{48}$/m);
        assert.ok(env.startsWith(OLD_ENV), 'the existing lines stay as they were');
        assert.ok(res.calls.some((c) => c.args[0] === 'compose'), 'the compose command still runs');
    });
}

test('a BROWSER_WS_PATH that is already set is never overwritten', { skip: !hasBash }, (t) => {
    const dir = sandbox(t, { scripts: ['selfhost.sh'], files: { '.env': `${OLD_ENV}BROWSER_WS_PATH=keepme\n` } });
    const res = run(dir, 'selfhost.sh', ['--stop']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(envOf(dir), `${OLD_ENV}BROWSER_WS_PATH=keepme\n`);
});

test('without a .env nothing is written', { skip: !hasBash }, (t) => {
    const dir = sandbox(t, { scripts: ['selfhost.sh'] });
    const res = run(dir, 'selfhost.sh', ['--stop']);
    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(!fs.existsSync(path.join(dir, '.env')));
});
