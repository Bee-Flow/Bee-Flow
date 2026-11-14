import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// The parser is the TypeScript compiler API (root typescript-api, else agent-hub's). The
// workflow-policy job runs the scripts' tests without npm ci, so these skip there.
let hasTs = false;
for (const [from, name] of [['../package.json', 'typescript-api'], ['../agent-hub/package.json', 'typescript']]) {
    try { createRequire(new URL(from, import.meta.url))(name); hasTs = true; break; } catch { /* not installed */ }
}
const tsTest = hasTs ? test : test.skip;
const { nonAtomicWrites, tablesWritten, isStoreSource } = await import('./store-write-tx.mjs');

const names = (text, file) => nonAtomicWrites(text, file).map((f) => f.name);

test('tablesWritten reads INSERT, UPDATE and DELETE targets and leaves ON CONFLICT DO UPDATE to its INSERT', () => {
    assert.deepEqual(tablesWritten('INSERT INTO a (x) VALUES ($1) ON CONFLICT (x) DO UPDATE SET x = EXCLUDED.x'), ['a']);
    assert.deepEqual(tablesWritten('WITH d AS (DELETE FROM "B" WHERE id = $1) UPDATE c x SET n = 1'), ['c', 'b']);
    assert.deepEqual(tablesWritten('UPDATE ${table} SET deleted = TRUE'), ['${table}']);
    assert.deepEqual(tablesWritten('SELECT * FROM a FOR UPDATE SKIP LOCKED'), []);
});

tsTest('two statements on two tables without a transaction are counted, once, on the innermost function', () => {
    const text = `
async function removeThing(id) {
    await db.run('DELETE FROM thing_parts WHERE thing_id = $1', [id]);
    await db.run(\`DELETE FROM things WHERE id = $1\`, [id]);
}
function makeStore(db) {
    return {
        async a() { await db.run('INSERT INTO x VALUES (1)'); await db.run('UPDATE y SET n = 1'); },
        async b() { await db.run('INSERT INTO z VALUES (1)'); },
        c: async () => { await db.run('DELETE FROM w'); },
    };
}
async function viaCallback(rows) {
    await Promise.all(rows.map((r) => db.run('INSERT INTO p VALUES ($1)', [r])));
    await db.run('UPDATE q_counts SET n = n + 1');
}`;
    assert.deepEqual(names(text), ['removeThing', 'a', 'viaCallback']);
});

tsTest('a transaction, a caller client, a hand-opened BEGIN, one CTE statement or a stepwise comment is not counted', () => {
    const text = `
async function inTx(id) {
    return db.withTransaction(async (c) => {
        await c.query('DELETE FROM parts WHERE id = $1', [id]);
        await c.query('DELETE FROM things WHERE id = $1', [id]);
    });
}
async function viaRunner(id) {
    return runTransaction(await getClient(), async (c) => {
        await c.query('INSERT INTO a VALUES (1)'); await c.query('INSERT INTO b VALUES (1)');
    });
}
async function joins(id, client = null) { await q(client).query('INSERT INTO a VALUES (1)'); await q(client).query('INSERT INTO b VALUES (1)'); }
async function joinsOpts(id, { db = pool } = {}) { await db.query('INSERT INTO a VALUES (1)'); await db.query('INSERT INTO b VALUES (1)'); }
async function joinsProp(id, opts) { const c = opts.client; await c.query('INSERT INTO a VALUES (1)'); await c.query('INSERT INTO b VALUES (1)'); }
async function byHand(c) { await c.query('BEGIN'); await c.query('INSERT INTO a VALUES (1)'); await c.query('INSERT INTO b VALUES (1)'); }
async function oneStatement() { await db.run('WITH d AS (DELETE FROM a RETURNING id) INSERT INTO b SELECT id FROM d'); }
async function sameTable() { await db.run('INSERT INTO a VALUES (1)'); await db.run('UPDATE a SET n = 2'); }
// stepwise: erasure re-runs to completion, each step is idempotent
async function erase(id) { await db.run('DELETE FROM a'); await db.run('DELETE FROM b'); }
/** JSDoc between is fine. */
// stepwise: the sweep re-runs on the next tick
const sweep = async () => { await db.run('DELETE FROM a'); await db.run('DELETE FROM b'); };
async function eraseTrail(id) { // stepwise: on the line that opens the body
    await db.run('DELETE FROM a'); await db.run('DELETE FROM b');
}
// SQL in a comment: INSERT INTO a ... UPDATE b SET
async function comment() { /* DELETE FROM a */ await db.run('DELETE FROM b'); }`;
    assert.deepEqual(names(text), []);
});

tsTest('a positional run or h is the caller executor, a destructured { run } is not, and a stepwise line above the passing statement counts', () => {
    const text = `
async function viaRun(run, id) { await run('DELETE FROM a WHERE id = $1', [id]); await run('DELETE FROM b WHERE id = $1', [id]); }
async function viaHandle(h, id) { await h.run('DELETE FROM a'); await h.run('DELETE FROM b'); }
function createChecks({ run }) {
    return { async write() { await run('INSERT INTO a VALUES (1)'); await run('INSERT INTO b VALUES (1)'); } };
}
// stepwise: a boot migration, re-run at every boot
const initDB = makeStoreInit('X', async () => { await exec('UPDATE a SET n = 1'); await exec('UPDATE b SET n = 1'); });
async function erase(userId, step) {
    // stepwise: one erasure step, idempotent
    await step('rows', async () => { await run('DELETE FROM a'); await run('DELETE FROM b'); });
}`;
    assert.deepEqual(names(text), ['write']);
});

tsTest('a factory parameter named db is no caller client, and TypeScript sources are read too', () => {
    const text = `
export function makeStore(db: Db) {
    async function write(id: string): Promise<void> {
        await db.query('INSERT INTO a VALUES ($1)', [id]);
        await db.query('UPDATE b SET n = n + 1');
    }
    return { write };
}`;
    assert.deepEqual(nonAtomicWrites(text, 'stores/x.mts'), [{ name: 'write', line: 3, tables: ['a', 'b'] }]);
});

test('isStoreSource reads stores/ sources only, without tests or testkits', () => {
    assert.ok(isStoreSource('stores/a.js'));
    assert.ok(isStoreSource('stores/sub/b.mts'));
    assert.ok(!isStoreSource('stores/a.test.js'));
    assert.ok(!isStoreSource('stores/a.pg.test.js'));
    assert.ok(!isStoreSource('stores/adoption/adoption.testkit.js'));
    assert.ok(!isStoreSource('core/a.js'));
});

tsTest('the store-write-tx ratchet records, holds and fails a new non-atomic store function', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-write-tx-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    for (const f of ['count-ratchet.mjs', 'store-write-tx.mjs']) fs.copyFileSync(path.join(HERE, f), path.join(dir, 'scripts', f));
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.symlinkSync(path.join(HERE, '..', 'node_modules'), path.join(dir, 'node_modules'));
    const stores = path.join(dir, 'server', 'stores');
    fs.mkdirSync(stores, { recursive: true });
    const two = "async function f() { await db.run('DELETE FROM a'); await db.run('DELETE FROM b'); }\n";
    fs.writeFileSync(path.join(stores, 'a.js'), two);
    fs.writeFileSync(path.join(stores, 'a.test.js'), two);
    fs.mkdirSync(path.join(dir, 'server', 'core'));
    fs.writeFileSync(path.join(dir, 'server', 'core', 'b.js'), two);
    const run = () => {
        try {
            return { code: 0, out: execFileSync(process.execPath, ['scripts/count-ratchet.mjs', 'store-write-tx', 'server'], { cwd: dir, encoding: 'utf8' }) };
        } catch (e) {
            return { code: e.status, out: `${e.stdout}${e.stderr}` };
        }
    };
    assert.equal(run().code, 0);
    const budget = () => JSON.parse(fs.readFileSync(path.join(dir, 'server', '.store-write-tx-ratchet.json'), 'utf8')).count;
    assert.equal(budget(), 1);
    fs.writeFileSync(path.join(stores, 'c.mts'), two);
    const r = run();
    assert.equal(r.code, 1);
    assert.match(r.out, /2 store functions writing two or more tables without a transaction/);
    assert.match(r.out, /withTransaction/);
});
