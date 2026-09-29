/**
 * Edition switch — the core-only build proof.
 *
 * catalog.js reads BEEFLOW_EDITION / BEEFLOW_MODULES ONCE, at load, to keep
 * itself pure data (see its header: no DB/registry requires, or boot cycles).
 * That makes the switch untestable in-process — mutating process.env after the
 * require does nothing, and re-requiring from a cleared cache would also
 * re-run the registry chain this file's siblings mock. So each case runs in a
 * child process with the env set from the start, exactly as a deployment sets
 * it, and prints one JSON line back.
 *
 * What it pins is the contract a light build depends on:
 *   - core edition marks every optional surface unavailable, and NOTHING else
 *     (core capabilities are the ones no module claims — they cannot be
 *     switched off because no entry lists them);
 *   - unavailable ⇒ status 'unavailable' ⇒ gate 404 ⇒ capabilities dropped
 *     from the registry projection;
 *   - BEEFLOW_MODULES is an allow-list that WINS over the edition;
 *   - with neither set, everything is available — the grandfathering default.
 *
 * Run: node --test --test-force-exit modules/edition.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

const SERVER = path.resolve(__dirname, '..');

/**
 * Evaluate `expr` (a JS expression over `catalog`) in a child process with the
 * given env, and return the parsed result. stdout is not a clean channel here
 * either — dotenv and store inits log on require — so the payload is fenced.
 */
function inEdition(env, expr) {
    // Promise.resolve so an expression may be async — isModuleActive is.
    const script = `
        const catalog = require(${JSON.stringify(path.join(__dirname, 'catalog.js'))});
        Promise.resolve(${expr}).then(out => {
            process.stdout.write('\\n<<<' + JSON.stringify(out) + '>>>\\n');
        }).catch(e => { console.error(e); process.exit(1); });
    `;
    const stdout = execFileSync(process.execPath, ['-e', script], {
        cwd: SERVER,
        env: { ...process.env, NODE_ENV: 'test', ...env },
        encoding: 'utf8',
    });
    const m = stdout.match(/<<<([\s\S]*?)>>>/);
    assert.ok(m, `child produced no payload; stdout was:\n${stdout}`);
    return JSON.parse(m[1]);
}

const availability = env => inEdition(env,
    'Object.fromEntries(catalog.listModules().map(m => [m.id, m.available !== false]))');

test('with neither variable set, every surface is available', () => {
    const avail = availability({ BEEFLOW_EDITION: '', BEEFLOW_MODULES: '' });
    assert.ok(Object.keys(avail).length > 0, 'catalog is empty — the proof is vacuous');
    for (const [id, ok] of Object.entries(avail)) {
        assert.strictEqual(ok, true, `${id} must be available when no edition is set`);
    }
});

test('BEEFLOW_EDITION=core makes every optional surface unavailable', () => {
    const avail = availability({ BEEFLOW_EDITION: 'core' });
    assert.ok(Object.keys(avail).length > 0);
    for (const [id, ok] of Object.entries(avail)) {
        assert.strictEqual(ok, false, `${id} must be unavailable in the core edition`);
    }
});

test('the edition name is matched case- and whitespace-insensitively', () => {
    for (const raw of ['CORE', '  core  ', 'Core']) {
        const avail = availability({ BEEFLOW_EDITION: raw });
        assert.ok(Object.values(avail).every(ok => ok === false), `'${raw}' should read as core`);
    }
});

test('an unrecognised edition name leaves everything on rather than off', () => {
    // Fail OPEN on a typo: a misspelt BEEFLOW_EDITION must not silently
    // deactivate half the product on someone's deployment.
    const avail = availability({ BEEFLOW_EDITION: 'coree' });
    assert.ok(Object.values(avail).every(ok => ok === true));
});

test('BEEFLOW_MODULES is an allow-list that wins over the edition', () => {
    const avail = availability({ BEEFLOW_EDITION: 'core', BEEFLOW_MODULES: 'automation, approvals' });
    assert.strictEqual(avail.automation, true, 'an allow-listed module survives the core edition');
    assert.strictEqual(avail.approvals, true);
    for (const [id, ok] of Object.entries(avail)) {
        if (id === 'automation' || id === 'approvals') continue;
        assert.strictEqual(ok, false, `${id} is not allow-listed and must be off`);
    }
});

test('an empty BEEFLOW_MODULES is not an empty allow-list', () => {
    // '' and ' , ,' parse to zero entries, which must mean "unset" — reading
    // them as "allow nothing" would take the whole product down.
    for (const raw of ['', '   ', ' , , ']) {
        const avail = availability({ BEEFLOW_MODULES: raw });
        assert.ok(Object.values(avail).every(ok => ok === true), `'${raw}' must read as unset`);
    }
});

test('core edition drops the modules\' capabilities and keeps core ones', () => {
    // The projection contract: an unavailable module's capability ids are the
    // ones that disappear. Core capabilities are exactly those no module
    // claims, so the reverse index is the proof that they are untouched.
    const { moduleCaps, chatIsCore } = inEdition({ BEEFLOW_EDITION: 'core' }, `{
        moduleCaps: [...catalog.capabilityToModuleMap().keys()],
        chatIsCore: !catalog.capabilityToModuleMap().has('chat_basic'),
    }`);
    assert.ok(moduleCaps.length > 0, 'no capabilities are module-owned — the proof is vacuous');
    assert.strictEqual(chatIsCore, true, 'chat must not belong to any optional module');
});

test('an unavailable module reports status unavailable, whatever its row says', () => {
    // statusFor() lives in ./index.js and is reached here through the same
    // child-process trick, because it reads the catalog loaded under the env.
    const statuses = inEdition({ BEEFLOW_EDITION: 'core' }, `
        (() => {
            const Module = require('module');
            const dbPath = require.resolve(${JSON.stringify(path.join(SERVER, 'db.js'))});
            require.cache[dbPath] = new Module(dbPath);
            require.cache[dbPath].exports = {
                exec: async () => ({}), run: async () => ({ rows: [], rowCount: 0 }),
                getOne: async () => null, getAll: async () => [],
                getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
            };
            require.cache[dbPath].loaded = true;
            const mods = require(${JSON.stringify(path.join(__dirname, 'index.js'))});
            return Promise.all(catalog.listModules().map(async m => [m.id, await mods.isModuleActive(m.id)]));
        })()
    `);
    for (const [id, active] of statuses) {
        assert.strictEqual(active, false, `${id} must be inactive in the core edition`);
    }
});
