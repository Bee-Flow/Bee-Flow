// Unit tests of the pure parts of core-boot-check.mjs: arguments, the server's environment,
// the expected answer per probe and edition, and the log filters. The run itself needs a
// Postgres and is ci.yml's `server-core` job.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { editionHas, errorLines, forbiddenLines, parseArgs, probeFailures, probesFor, serverEnv } from './core-boot-check.mjs';

const DB = 'postgresql://beeflow@127.0.0.1:5432/x';
const MAP = { automation: { requires: ['datatables'] }, datatables: {}, apps: { requires: ['automation'] } };

describe('parseArgs', () => {
    it('reads the flags and defaults the port', () => {
        assert.deepEqual(parseArgs(['--database', DB, '--hide-modules', 'all', '--expect-tables', '138']), {
            database: DB, hide: 'all', edition: null, modules: null, port: 3199, expectTables: 138,
        });
        assert.equal(parseArgs(['--database', DB, '--port', '4000']).port, 4000);
    });
    it('refuses a missing database, an unknown flag, a missing value and two editions', () => {
        assert.throws(() => parseArgs([]), /--database/);
        assert.throws(() => parseArgs(['--database', DB, '--nope', 'x']), /unknown argument/);
        assert.throws(() => parseArgs(['--database', DB, '--port']), /needs a value/);
        assert.throws(() => parseArgs(['--database', DB, '--port', '--edition']), /needs a value/);
        assert.throws(() => parseArgs(['--database', DB, '--port', 'abc']), /whole number/);
        assert.throws(() => parseArgs(['--database', DB, '--edition', 'core', '--modules', 'apps']), /choose one/);
    });
});

describe('serverEnv', () => {
    it('takes only PATH and HOME from the caller and sets the edition variable', () => {
        const env = serverEnv(parseArgs(['--database', DB, '--edition', 'core']), { PATH: '/bin', HOME: '/h', SECRET: 'x' });
        assert.equal(env.PATH, '/bin');
        assert.equal(env.HOME, '/h');
        assert.equal(env.SECRET, undefined);
        assert.equal(env.BEEFLOW_EDITION, 'core');
        assert.equal(env.BEEFLOW_HIDE_MODULES, undefined);
        assert.equal(env.CORE_DATABASE_URL, DB);
        assert.equal(env.NODE_ENV, 'production');
        assert.equal(env.OTEL_ENABLED, 'false');
        assert.ok(env.SESSION_SECRET.length >= 32 && env.MASTER_ENCRYPTION_KEY.length >= 32);
    });
    it('passes a hide list and a module list through', () => {
        assert.equal(serverEnv(parseArgs(['--database', DB, '--hide-modules', 'all']), {}).BEEFLOW_HIDE_MODULES, 'all');
        assert.equal(serverEnv(parseArgs(['--database', DB, '--modules', 'apps,cms']), {}).BEEFLOW_MODULES, 'apps,cms');
    });
});

describe('editionHas and probesFor', () => {
    const opts = (/** @type {string[]} */ ...rest) => parseArgs(['--database', DB, ...rest]);
    it('every module without an edition', () => {
        assert.equal(editionHas(opts(), 'automation', MAP), true);
        assert.deepEqual(probesFor(opts(), MAP).map((p) => p.expect), [200, 401, 401, 401]);
    });
    it('none with every module hidden or edition core', () => {
        assert.deepEqual(probesFor(opts('--hide-modules', 'all'), MAP).map((p) => p.expect), [200, 401, 404, 404]);
        assert.deepEqual(probesFor(opts('--edition', 'core'), MAP).map((p) => p.expect), [200, 401, 404, 404]);
    });
    it('a hide list hides only the named modules', () => {
        assert.equal(editionHas(opts('--hide-modules', 'automation'), 'automation', MAP), false);
        assert.equal(editionHas(opts('--hide-modules', 'automation'), 'datatables', MAP), true);
    });
    it('a module list has the listed modules, leaves the others out, and does not assert a required one', () => {
        assert.equal(editionHas(opts('--modules', 'datatables'), 'datatables', MAP), true);
        assert.equal(editionHas(opts('--modules', 'datatables'), 'automation', MAP), false);
        assert.equal(editionHas(opts('--modules', 'apps'), 'datatables', MAP), null);
        assert.deepEqual(probesFor(opts('--modules', 'apps'), MAP).map((p) => p.expect), [200, 401, null, null]);
    });
});

describe('probeFailures', () => {
    it('names each probe that answered otherwise and skips the unasserted ones', () => {
        const probes = [{ path: '/a', expect: 200 }, { path: '/b', expect: null }, { path: '/c', expect: 404 }];
        assert.deepEqual(probeFailures(probes, { '/a': 200, '/b': 500, '/c': 401 }), ['GET /c answered 401, expected 404']);
    });
});

describe('log filters', () => {
    const log = [
        '{"level":"info","msg":"fine"}',
        '{"level":"error","msg":"[Search] SERVICES_API_KEY is not set"}',
        '{"level":60,"msg":"fatal by number"}',
        '{not json',
        'TypeError: x is not a function',
        'Error: Cannot find module \'../stores/coworkStore\'',
        '{"level":"warn","msg":"feature module \\"stores/x\\" is not present"}',
        'a line that mentions an error in passing',
    ].join('\n');
    it('errorLines keeps error and fatal levels and uncaught errors', () => {
        assert.deepEqual(errorLines(log), [
            '{"level":"error","msg":"[Search] SERVICES_API_KEY is not set"}',
            '{"level":60,"msg":"fatal by number"}',
            'TypeError: x is not a function',
            'Error: Cannot find module \'../stores/coworkStore\'',
        ]);
    });
    it('forbiddenLines finds a core file reaching for a module', () => {
        assert.equal(forbiddenLines(log).length, 2);
        assert.deepEqual(forbiddenLines('{"level":"info","msg":"ok"}'), []);
    });
});
