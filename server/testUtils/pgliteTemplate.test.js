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
const { newPglite, templateFile, readVerified, writeAtomic } = require('./pgliteTemplate');

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
