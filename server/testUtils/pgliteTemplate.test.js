// @typecheck strict
/**
 * testUtils/pgliteTemplate.js: the pre-initialised data directory behind
 * newPglite() must be the same database `new PGlite()` boots, and a template
 * file that is damaged must be dropped, never used.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const crypto = require('node:crypto');
const { newPglite, templateFile, readVerified, writeAtomic, sourceHash } = require('./pgliteTemplate');
const { roots } = require('../moduleRoots.cjs');

const FINGERPRINT = `SELECT current_database() AS db, version() AS v, current_setting('TimeZone') AS tz,
    current_setting('server_encoding') AS enc, (SELECT string_agg(datname || ':' || datcollate, ',' ORDER BY datname) FROM pg_database) AS databases,
    (SELECT string_agg(nspname, ',' ORDER BY nspname) FROM pg_namespace) AS schemas,
    (SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles) AS roles,
    (SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension) AS ext,
    (SELECT count(*)::int FROM pg_class WHERE relnamespace = 'public'::regnamespace) AS public_relations`;

test('newPglite() is the database a plain new PGlite() boots', async () => {
    const plain = new PGlite();
    const templated = newPglite();
    try {
        assert.deepStrictEqual((await templated.query(FINGERPRINT)).rows, (await plain.query(FINGERPRINT)).rows);
        await templated.exec('CREATE TABLE t (id int); INSERT INTO t VALUES (1)');
        assert.deepStrictEqual((await plain.query("SELECT to_regclass('t') AS t")).rows, [{ t: null }], 'two instances never share state');
    } finally {
        await plain.close();
        await templated.close();
    }
});

test('newPglite(options) keeps the options (parsers) and respects an explicit data directory', async () => {
    const pg = newPglite({ parsers: { 20: (/** @type {string} */ v) => `big:${v}` } });
    try {
        assert.deepStrictEqual((await pg.query('SELECT 1::int8 AS n')).rows, [{ n: 'big:1' }]);
    } finally {
        await pg.close();
    }
    const mem = newPglite({ dataDir: 'memory://' });
    try {
        assert.deepStrictEqual((await mem.query('SELECT 1 AS n')).rows, [{ n: 1 }]);
    } finally {
        await mem.close();
    }
});

test('a template file is read back only when it matches its own checksum', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-template-'));
    try {
        const file = path.join(dir, 'empty-aaaa.tgz');
        const payload = Buffer.from('some data directory');

        writeAtomic(file, payload);
        assert.deepStrictEqual(readVerified(file), payload);
        assert.deepStrictEqual(fs.readdirSync(dir), ['empty-aaaa.tgz'], 'no temp file is left behind');

        const raw = fs.readFileSync(file);
        raw[raw.length - 1] ^= 0xff;                        // one flipped bit in the payload
        fs.writeFileSync(file, raw);
        assert.strictEqual(readVerified(file), null);
        assert.strictEqual(fs.existsSync(file), false, 'a corrupt template is deleted so the next build replaces it');

        writeAtomic(file, payload);
        fs.writeFileSync(file, fs.readFileSync(file).subarray(0, 20));   // truncated
        assert.strictEqual(readVerified(file), null);
        assert.strictEqual(readVerified(path.join(dir, 'missing.tgz')), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('publishing a template drops the ones of an older key, and only of its own kind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-template-'));
    try {
        fs.writeFileSync(path.join(dir, 'ladder-old.tgz'), 'x');
        fs.writeFileSync(path.join(dir, 'empty-old.tgz'), 'x');
        const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
        for (const f of ['ladder-old.tgz', 'empty-old.tgz']) fs.utimesSync(path.join(dir, f), old, old);
        writeAtomic(path.join(dir, 'ladder-new.tgz'), Buffer.from('y'));
        assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['empty-old.tgz', 'ladder-new.tgz']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the ladder key follows the server source, the empty key does not', () => {
    const ladder = templateFile('ladder');
    assert.match(path.basename(ladder), /^ladder-[0-9a-f]{20}\.tgz$/);
    assert.match(path.basename(templateFile('empty')), /^empty-[0-9a-f]{20}\.tgz$/);
    assert.strictEqual(templateFile('ladder'), ladder, 'stable for an unchanged tree');
});

test('with only the core root the source hash is the plain walk of server/ (no cached template is invalidated)', () => {
    // The walk sourceHash() did before it covered every root, kept here as the reference.
    const SERVER = path.join(__dirname, '..');
    const h = crypto.createHash('sha256');
    const walk = (/** @type {string} */ dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (!['node_modules', '.git', 'coverage', 'dist', 'journeys'].includes(e.name)) walk(p); continue; }
            if (e.isFile() && /\.(c|m)?js$|\.mts$|\.ts$|\.json$|\.sql$|\.md$|\.txt$/.test(e.name) && !/\.test\./.test(e.name)) {
                h.update(path.relative(SERVER, p)).update('\0').update(fs.readFileSync(p));
            }
        }
    };
    walk(SERVER);
    const coreOnly = h.digest('hex');
    if (roots().length === 1) assert.strictEqual(sourceHash(), coreOnly);
    else assert.notStrictEqual(sourceHash(), coreOnly, 'the module roots are part of the hash');
});

test('writeAtomic keeps a fresh template of another key (a parallel test process may be reading it) and drops a stale one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-tpl-'));
    const fresh = path.join(dir, 'ladder-aaaa.tgz');
    const stale = path.join(dir, 'ladder-bbbb.tgz');
    fs.writeFileSync(fresh, 'x');
    fs.writeFileSync(stale, 'x');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, old, old);
    writeAtomic(path.join(dir, 'ladder-cccc.tgz'), Buffer.from('payload'));
    assert.ok(fs.existsSync(fresh), 'a template written minutes ago is left alone');
    assert.ok(!fs.existsSync(stale), 'a template of an old key is cleaned up');
    assert.ok(readVerified(path.join(dir, 'ladder-cccc.tgz')));
    fs.rmSync(dir, { recursive: true, force: true });
});
