/**
 * packageLoader tests — the trust-then-run lifecycle for remote modules.
 *
 * A real `.bfmod` fixture is built IN-TEST (jszip + an ephemeral RSA key whose
 * public half is injected via __setKeyResolversForTest), so signature +
 * integrity verification runs for real. DB/stores are in-memory require.cache
 * stubs; the data root is a throwaway temp dir.
 *
 * Covers: verifyAndStage signature verify (+ tamper reject + incompat reject),
 * activate wiring (capability descriptor registration + dispatcher routing),
 * the dispatcher 404-conceal for unknown/removed modules, worker-tick
 * self-gating on isModuleActive, and boot re-verify isolation (one package's
 * failure never blocks the others).
 *
 * Run: node --test modules/packageLoader.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const JSZip = require('jszip');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-at-least-32-chars-long';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'test-master-encryption-key-at-least-32-chars';

function mock(request, exports) {
    const p = require.resolve(request);
    require.cache[p] = new Module(p);
    require.cache[p].exports = exports;
    require.cache[p].loaded = true;
}

// ── db + catalog stubs ──────────────────────────────────────────────────────
mock('../db', {
    exec: async () => ({}),
    run: async () => ({ rows: [], rowCount: 0 }),
    getOne: async () => null,
    getAll: async () => [],
    getClient: async () => ({ query: async () => ({ rows: [] }), release() {} }),
    pool: { query: async () => ({ rows: [] }) },
    getRedis: () => null,
});
mock('./catalog', {
    MODULES: [],
    listModules: () => [],
    getModule: () => null,
    capabilityToModuleMap: () => new Map(),
});

// ── in-memory platformModuleStore ──────────────────────────────────────────
const stateRows = new Map();
mock('../stores/platformModuleStore', {
    initDB: async () => {},
    getAllStates: async () => [...stateRows.values()].map(r => ({ ...r })),
    getState: async (id) => (stateRows.get(id) ? { ...stateRows.get(id) } : null),
    setImported: async (id, { actorId = null, version = null, settings = undefined } = {}) => {
        const prev = stateRows.get(id) || {};
        const row = { ...prev, moduleId: id, status: 'imported', version, importedBy: actorId };
        if (settings !== undefined) row.settings = settings;
        stateRows.set(id, row); return { ...row };
    },
    setRemoved: async (id, { actorId = null } = {}) => {
        const prev = stateRows.get(id) || {};
        const row = { ...prev, moduleId: id, status: 'removed', removedBy: actorId };
        stateRows.set(id, row); return { ...row };
    },
    mergeSettings: async (id, patch) => {
        const prev = stateRows.get(id); if (!prev) return null;
        prev.settings = { ...(prev.settings || {}), ...patch };
        return { ...prev };
    },
});

// ── in-memory platformModulePackageStore ───────────────────────────────────
const pkgRows = new Map(); // `${id}@${version}` → row
mock('../stores/platformModulePackageStore', {
    initDB: async () => {},
    setActive: async (id, version, { manifest = null, kid = null, packageSha256 = null, source = null } = {}) => {
        for (const [, r] of pkgRows) { if (r.moduleId === id && r.version !== version && r.status === 'active') r.status = 'retired'; }
        const prev = pkgRows.get(`${id}@${version}`) || {};
        const row = { moduleId: id, version, status: 'active', manifest, kid, packageSha256, error: null, source: source || prev.source || 'hub', prunedAt: null, installedBy: null };
        pkgRows.set(`${id}@${version}`, row); return { ...row };
    },
    setStaged: async (id, version, { manifest = null, kid = null, packageSha256 = null, source = null } = {}) => {
        const row = { moduleId: id, version, status: 'staged', manifest, kid, packageSha256, error: null, source: source || 'hub', prunedAt: null, installedBy: null };
        pkgRows.set(`${id}@${version}`, row); return { ...row };
    },
    setQuarantined: async (id, version, { error = null } = {}) => {
        const row = pkgRows.get(`${id}@${version}`);
        if (row) { row.status = 'quarantined'; row.error = error; }
        return row ? { ...row } : null;
    },
    setFailed: async (id, version, { error = null, status = 'failed' } = {}) => {
        const row = { moduleId: id, version, status, error };
        pkgRows.set(`${id}@${version}`, row); return { ...row };
    },
    markPruned: async (id, version) => {
        const row = pkgRows.get(`${id}@${version}`);
        if (row) row.prunedAt = new Date().toISOString();
        return row ? { ...row } : null;
    },
    getActive: async (id) => {
        for (const r of pkgRows.values()) if (r.moduleId === id && r.status === 'active') return { ...r };
        return null;
    },
    listActive: async () => [...pkgRows.values()].filter(r => r.status === 'active').map(r => ({ ...r })),
    listStaged: async () => [...pkgRows.values()].filter(r => r.status === 'staged').map(r => ({ ...r })),
    listRollbackCandidates: async (id) => [...pkgRows.values()]
        .filter(r => r.moduleId === id && r.status === 'retired' && !r.prunedAt)
        .map(r => ({ ...r })),
    listForModule: async (id) => [...pkgRows.values()].filter(r => r.moduleId === id).map(r => ({ ...r })),
    getPackage: async (id, version) => (pkgRows.get(`${id}@${version}`) ? { ...pkgRows.get(`${id}@${version}`) } : null),
});

// ── in-memory configStore (offline-grant stash, meta last-good, kid cache) ──
const configMap = new Map();
mock('../stores/configStore', {
    getConfig: async (k) => (configMap.has(k) ? configMap.get(k) : null),
    setConfig: async (k, v) => { configMap.set(k, v); return true; },
    getSecret: async (k) => (configMap.has(`s:${k}`) ? configMap.get(`s:${k}`) : null),
    setSecret: async (k, v) => { if (!v) configMap.delete(`s:${k}`); else configMap.set(`s:${k}`, v); return true; },
});

const packageLoader = require('./packageLoader');
const registry = require('../core/entitlements/capabilityRegistry');

// ── Ephemeral signing key + fixture builder ────────────────────────────────
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-kid';

function sha256hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function signJws(payload) {
    const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWS', kid: KID }));
    const p = b64url(JSON.stringify(payload));
    const signingInput = `${h}.${p}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
    return `${signingInput}.${b64url(sig)}`;
}

async function buildPackage({
    id, version, capabilities = [], withFrontend = false, tickBody = '',
    hostApiVersion = 1, minAppVersion = null,
    manifestVersion = null, permissions = null, licenseClass = null,
    serverExtra = null, entryExtra = '', extraInstanceProps = '', extraFiles = null,
}) {
    const manifest = {
        id, name: `Mod ${id}`, version, description: '', category: 'Modules', icon: 'box',
        capabilities,
        server: { entry: 'server/index.cjs', host_api_version: hostApiVersion, ...(serverExtra || {}) },
    };
    if (manifestVersion != null) manifest.manifestVersion = manifestVersion;
    if (permissions != null) manifest.permissions = permissions;
    if (withFrontend) manifest.frontend = { entry: 'index.js', urlSegment: id };
    if (minAppVersion) manifest.min_app_version = minAppVersion;

    const entrySrc = `
module.exports.createModule = function (hostApi) {
  const router = hostApi.express.Router();
  router.get('/ping', (req, res) => res.json({ pong: true, module: hostApi.moduleId }));
  ${entryExtra}
  return {
    router,
    initDBs: async () => {},
    ${tickBody ? `tick: async () => { ${tickBody} }, tickIntervalMs: 20,` : ''}
    ${extraInstanceProps}
  };
};
`;

    const files = new Map();
    files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    files.set('server/index.cjs', Buffer.from(entrySrc));
    if (withFrontend) files.set('frontend/index.js', Buffer.from('console.log("fe");'));
    for (const [name, buf] of Object.entries(extraFiles || {})) files.set(name, Buffer.from(buf));

    const integrity = { algo: 'sha256', files: {} };
    for (const [name, buf] of files) integrity.files[name] = sha256hex(buf);
    const integrityBuf = Buffer.from(JSON.stringify(integrity));

    const jws = signJws({
        iss: 'license.beeflow.nl/modules',
        module_id: id, version,
        integrity_sha256: sha256hex(integrityBuf),
        iat: Math.floor(Date.now() / 1000),
        host_api_version: hostApiVersion,
        ...(minAppVersion ? { min_app_version: minAppVersion } : {}),
        ...(licenseClass ? { license_class: licenseClass } : {}),
    });

    const zip = new JSZip();
    for (const [name, buf] of files) zip.file(name, buf);
    zip.file('integrity.json', integrityBuf);
    zip.file('signature.jws', Buffer.from(jws));
    return zip.generateAsync({ type: 'nodebuffer' });
}

const FUTURE = () => Math.floor(Date.now() / 1000) + 3600 * 24;
function activeEnt() { return { kind: 'free', status: 'active', exp: FUTURE() }; }

let dataRoot;
before(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgloader-'));
    packageLoader.__setDataRootForTest(dataRoot);
    packageLoader.__setKeyResolversForTest({
        packageResolver: async () => publicKey,
        grantResolver: async () => publicKey,
    });
});
after(() => { try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch (_) {} });

beforeEach(() => {
    stateRows.clear();
    pkgRows.clear();
    require('./index').invalidateCache();
});

test('verifyAndStage verifies a signed package and extracts it', async () => {
    const buf = await buildPackage({ id: 'stage_mod', version: '1.0.0' });
    const staged = await packageLoader.verifyAndStage('stage_mod', '1.0.0', { buffer: buf });
    assert.strictEqual(staged.manifest.id, 'stage_mod');
    assert.strictEqual(staged.kid, KID);
    const entry = path.join(packageLoader.versionDir('stage_mod', '1.0.0'), 'server', 'index.cjs');
    assert.ok(fs.existsSync(entry), 'entry extracted to disk');
});

test('verifyAndStage rejects a tampered package', async () => {
    const buf = await buildPackage({ id: 'tamper_mod', version: '1.0.0' });
    // Flip a byte in the middle of the ZIP.
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    await assert.rejects(() => packageLoader.verifyAndStage('tamper_mod', '1.0.0', { buffer: buf }));
});

test('verifyAndStage rejects an incompatible host_api_version', async () => {
    const buf = await buildPackage({ id: 'incompat_mod', version: '1.0.0', hostApiVersion: 99 });
    await assert.rejects(
        () => packageLoader.verifyAndStage('incompat_mod', '1.0.0', { buffer: buf }),
        (e) => e.compat === true
    );
});

test('activate registers capability descriptors; inactive filter drops them but getCapability stays unfiltered', async () => {
    const buf = await buildPackage({ id: 'cap_mod', version: '1.0.0', capabilities: [{ id: 'cap_mod_feat', kind: 'integration', name: 'Cap Feat' }] });
    const staged = await packageLoader.verifyAndStage('cap_mod', '1.0.0', { buffer: buf });
    await packageLoader.activate('cap_mod', '1.0.0', { manifest: staged.manifest, kid: staged.kid, sha256: staged.sha256, entitlement: activeEnt() });

    assert.ok(registry.getCapability('cap_mod_feat'), 'descriptor registered');
    assert.ok(registry.listCapabilities().some(c => c.id === 'cap_mod_feat'), 'listed while active');

    // Lapse the entitlement PAST the 24h default grace, refresh — cap drops
    // from the projection…
    stateRows.get('cap_mod').settings.entitlement = { status: 'active', exp: Math.floor(Date.now() / 1000) - 25 * 3600 };
    require('./index').invalidateCache();
    await require('./index').refreshModuleActivations();
    assert.ok(!registry.listCapabilities().some(c => c.id === 'cap_mod_feat'), 'dropped when lapsed');
    // …but getCapability() stays UNFILTERED (mount-time lookups must survive).
    assert.ok(registry.getCapability('cap_mod_feat'), 'getCapability unfiltered');

    await packageLoader.deactivate('cap_mod', { persist: false });
});

test('dispatcher routes to an active module and 404-conceals unknown/removed', async () => {
    const buf = await buildPackage({ id: 'disp_mod', version: '1.0.0' }); // no caps ⇒ no cap gate
    const staged = await packageLoader.verifyAndStage('disp_mod', '1.0.0', { buffer: buf });
    await packageLoader.activate('disp_mod', '1.0.0', { manifest: staged.manifest, kid: staged.kid, sha256: staged.sha256, entitlement: activeEnt() });

    const express = require('express');
    const app = express();
    app.use('/api/mod', packageLoader.dispatchRouter);
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const ok = await fetch(`${base}/api/mod/disp_mod/ping`);
        assert.strictEqual(ok.status, 200);
        assert.deepStrictEqual(await ok.json(), { pong: true, module: 'disp_mod' });

        const unknown = await fetch(`${base}/api/mod/nope/ping`);
        assert.strictEqual(unknown.status, 404);

        // Remove ⇒ conceal.
        await packageLoader.deactivate('disp_mod', { persist: true });
        require('./index').invalidateCache();
        const gone = await fetch(`${base}/api/mod/disp_mod/ping`);
        assert.strictEqual(gone.status, 404);
    } finally {
        server.close();
    }
});

test('worker tick self-gates on isModuleActive', async () => {
    globalThis.__PLTICKS = 0;
    const buf = await buildPackage({ id: 'work_mod', version: '1.0.0', tickBody: 'globalThis.__PLTICKS++;' });
    const staged = await packageLoader.verifyAndStage('work_mod', '1.0.0', { buffer: buf });
    await packageLoader.activate('work_mod', '1.0.0', { manifest: staged.manifest, kid: staged.kid, sha256: staged.sha256, entitlement: activeEnt() });

    await new Promise(r => setTimeout(r, 90));
    const active = globalThis.__PLTICKS;
    assert.ok(active > 0, 'tick ran while active');

    // Make the module inactive WITHOUT clearing the timer — the self-gate must
    // stop the work.
    stateRows.get('work_mod').status = 'removed';
    require('./index').invalidateCache();
    await new Promise(r => setTimeout(r, 40));  // let any in-flight tick finish
    const snap = globalThis.__PLTICKS;
    await new Promise(r => setTimeout(r, 100)); // several intervals under the gate
    assert.strictEqual(globalThis.__PLTICKS, snap, 'tick suppressed while inactive');

    await packageLoader.deactivate('work_mod', { persist: false }); // stop the timer
});

test('loadInstalledAtBoot re-verifies from disk and isolates a bad package', async () => {
    // Two active packages; A good, B tampered on disk after staging.
    const bufA = await buildPackage({ id: 'boot_a', version: '1.0.0' });
    const bufB = await buildPackage({ id: 'boot_b', version: '1.0.0' });
    await packageLoader.verifyAndStage('boot_a', '1.0.0', { buffer: bufA });
    await packageLoader.verifyAndStage('boot_b', '1.0.0', { buffer: bufB });

    // Pre-seed persisted state (imported + entitled) + active package ledger.
    for (const id of ['boot_a', 'boot_b']) {
        stateRows.set(id, {
            moduleId: id, status: 'imported', version: '1.0.0',
            settings: { remote: true, manifest: { id, capabilities: [] }, entitlement: activeEnt() },
        });
        pkgRows.set(`${id}@1.0.0`, { moduleId: id, version: '1.0.0', status: 'active', packageSha256: null });
    }
    // Corrupt boot_b's retained .bfmod so re-verify fails.
    const bPkg = path.join(dataRoot, 'boot_b', 'pkg', '1.0.0.bfmod');
    await fsp.writeFile(bPkg, Buffer.from('not a zip'));

    const res = await packageLoader.loadInstalledAtBoot();
    assert.strictEqual(res.activated, 1);
    assert.strictEqual(res.failed, 1);
    assert.ok(packageLoader._dispatch.has('boot_a'), 'good module activated');
    assert.ok(!packageLoader._dispatch.has('boot_b'), 'bad module NOT activated');
    assert.strictEqual(pkgRows.get('boot_b@1.0.0').status, 'failed');

    await packageLoader.deactivate('boot_a', { persist: false });
});

// ── M2: mv2 permission manifest ──────────────────────────────────────────────

test('mv2 activate enforces the SIGNED permission list against the operator grant', async () => {
    const buf = await buildPackage({
        id: 'perm_mod', version: '1.0.0', manifestVersion: 2, hostApiVersion: 3,
        permissions: ['db'], entryExtra: 'globalThis.__permHost = hostApi;',
    });
    const staged = await packageLoader.verifyAndStage('perm_mod', '1.0.0', { buffer: buf });

    // No grant persisted, none passed ⇒ fail closed on EVERY activation path.
    await assert.rejects(
        () => packageLoader.activate('perm_mod', '1.0.0', { manifest: staged.manifest, kid: staged.kid, sha256: staged.sha256, entitlement: activeEnt() }),
        (e) => e.code === 'permissions_not_granted' && e.missingPermissions.includes('db')
    );

    // Granted ⇒ activates, and the module receives ONLY the granted surface.
    await packageLoader.activate('perm_mod', '1.0.0', {
        manifest: staged.manifest, kid: staged.kid, sha256: staged.sha256,
        entitlement: activeEnt(),
        grantedPermissions: { list: ['db'], acceptedBy: 'admin1', acceptedAt: new Date().toISOString() },
    });
    const host = globalThis.__permHost;
    assert.ok(host.db, 'granted surface present');
    assert.strictEqual(host.ai, undefined, 'ungranted surface absent');
    assert.strictEqual(host.stores, undefined, 'mv2 never sees the instance-wide configStore');
    assert.deepStrictEqual(host.permissions, ['db']);
    // Grant persisted onto the row for future boot re-checks.
    assert.deepStrictEqual(stateRows.get('perm_mod').settings.grantedPermissions.list, ['db']);

    // A tampered/grown grant demand fails the SAME invariant at re-activation.
    stateRows.get('perm_mod').settings.grantedPermissions = { list: [] };
    await assert.rejects(
        () => packageLoader.activate('perm_mod', '1.0.0', { manifest: staged.manifest, persist: false }),
        (e) => e.code === 'permissions_not_granted'
    );
    await packageLoader.deactivate('perm_mod', { persist: false });
    delete globalThis.__permHost;
});

test('mv2 package with non-module-own capability id is rejected at verify', async () => {
    const buf = await buildPackage({
        id: 'own_mod', version: '1.0.0', manifestVersion: 2, hostApiVersion: 3,
        capabilities: [{ id: 'someone_elses_cap' }],
    });
    await assert.rejects(
        () => packageLoader.verifyAndStage('own_mod', '1.0.0', { buffer: buf }),
        /package_verify_failed:capability_not_module_owned/
    );
});

test('mv2 with non-empty permissions requires hostApiVersion >= 3', async () => {
    const buf = await buildPackage({
        id: 'oldapi_mod', version: '1.0.0', manifestVersion: 2, hostApiVersion: 2,
        permissions: ['db'],
    });
    await assert.rejects(
        () => packageLoader.verifyAndStage('oldapi_mod', '1.0.0', { buffer: buf }),
        /package_verify_failed:permissions_require_host_api_3/
    );
});

// ── M3: sideload + offline grants ───────────────────────────────────────────

function makeGrant({ moduleId, sub = 'inst_x', kind = 'admin_granted', exp = FUTURE() }) {
    return signJws({
        iss: 'license.beeflow.nl', aud: 'beeflow-module', token_use: 'module_grant',
        sub, subject_type: 'license', module_id: moduleId,
        entitlement_id: `ent_${moduleId}`, kind,
        iat: Math.floor(Date.now() / 1000), exp,
    });
}

test('sideload: license_class free activates without any grant, source=sideload', async () => {
    const buf = await buildPackage({ id: 'free_side', version: '1.0.0', licenseClass: 'free' });
    const r = await packageLoader.sideloadFromBuffer(buf, { actorId: 'admin1' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.requiresRestart, false);
    assert.ok(packageLoader._dispatch.has('free_side'));
    const ent = stateRows.get('free_side').settings.entitlement;
    assert.strictEqual(ent.kind, 'free');
    assert.strictEqual(ent.source, 'offline');
    assert.strictEqual(pkgRows.get('free_side@1.0.0').source, 'sideload');
    await packageLoader.deactivate('free_side', { persist: false });
});

test('sideload: paid package without grant ⇒ 402 offline_grant_required, package retained staged', async () => {
    const buf = await buildPackage({ id: 'paid_side', version: '1.0.0' }); // no license_class ⇒ paid
    await assert.rejects(
        () => packageLoader.sideloadFromBuffer(buf, { actorId: 'admin1' }),
        (e) => e.code === 'offline_grant_required'
    );
    assert.ok(!packageLoader._dispatch.has('paid_side'), 'not activated');
    assert.strictEqual(pkgRows.get('paid_side@1.0.0').status, 'staged', 'retained for a later grant');

    // Apply a .bfgrant, then activate the staged package.
    const grant = {
        format: 'beeflow-offline-grant', format_version: 1, module_id: 'paid_side',
        subject: { type: 'license', id: 'inst_x' }, kind: 'admin_granted',
        grant_token: makeGrant({ moduleId: 'paid_side' }), kid: KID,
    };
    const applied = await packageLoader.applyOfflineGrant('paid_side', grant);
    assert.strictEqual(applied.ok, true);
    const act = await packageLoader.activateStaged('paid_side', { actorId: 'admin1' });
    assert.strictEqual(act.version, '1.0.0');
    assert.ok(packageLoader._dispatch.has('paid_side'));
    const ent = stateRows.get('paid_side').settings.entitlement;
    assert.strictEqual(ent.source, 'offline');
    assert.strictEqual(ent.kind, 'admin_granted');
    await packageLoader.deactivate('paid_side', { persist: false });
});

test('applyOfflineGrant rejects a grant for a different module or bad envelope', async () => {
    await assert.rejects(
        () => packageLoader.applyOfflineGrant('mod_a', {
            format: 'beeflow-offline-grant', format_version: 1, module_id: 'mod_b',
            grant_token: makeGrant({ moduleId: 'mod_b' }),
        }),
        (e) => e.code === 'grant_module_mismatch'
    );
    await assert.rejects(
        () => packageLoader.applyOfflineGrant('mod_a', { format: 'nope' }),
        (e) => e.code === 'bad_grant_format'
    );
    // Signed grant whose module_id claim doesn't match ⇒ grant_invalid.
    await assert.rejects(
        () => packageLoader.applyOfflineGrant('mod_a', {
            format: 'beeflow-offline-grant', format_version: 1, module_id: 'mod_a',
            grant_token: makeGrant({ moduleId: 'mod_b' }),
        }),
        (e) => e.code === 'grant_invalid'
    );
});

// ── M3: retention + rollback ────────────────────────────────────────────────

test('update retires the old version; rollback re-activates it; schema downgrade guarded', async () => {
    // v1.0.0 with schemaVersion 1 → active.
    const v1 = await buildPackage({ id: 'roll_mod', version: '1.0.0', serverExtra: { schemaVersion: 1 } });
    const s1 = await packageLoader.verifyAndStage('roll_mod', '1.0.0', { buffer: v1 });
    await packageLoader.activate('roll_mod', '1.0.0', { manifest: s1.manifest, kid: s1.kid, sha256: s1.sha256, entitlement: activeEnt() });

    // v1.1.0 with schemaVersion 2 → active; 1.0.0 retired.
    const v2 = await buildPackage({ id: 'roll_mod', version: '1.1.0', serverExtra: { schemaVersion: 2 } });
    const s2 = await packageLoader.verifyAndStage('roll_mod', '1.1.0', { buffer: v2 });
    await packageLoader.activate('roll_mod', '1.1.0', { manifest: s2.manifest, kid: s2.kid, sha256: s2.sha256, entitlement: activeEnt() });
    assert.strictEqual(pkgRows.get('roll_mod@1.0.0').status, 'retired');
    assert.strictEqual(packageLoader._dispatch.get('roll_mod').version, '1.1.0');

    // Versions listing joins the fs probe.
    const versions = await packageLoader.listVersions('roll_mod');
    assert.ok(versions.every(v => v.hasPackageFile), 'both packages retained on disk');

    // Rolling back 2→1 crosses a schema downgrade ⇒ guarded…
    await assert.rejects(
        () => packageLoader.rollbackTo('roll_mod', { version: '1.0.0' }),
        (e) => e.code === 'schema_downgrade'
    );
    // …unless forced.
    const rb = await packageLoader.rollbackTo('roll_mod', { version: '1.0.0', force: true });
    assert.strictEqual(rb.version, '1.0.0');
    assert.strictEqual(packageLoader._dispatch.get('roll_mod').version, '1.0.0');
    assert.strictEqual(pkgRows.get('roll_mod@1.0.0').status, 'active');
    assert.strictEqual(pkgRows.get('roll_mod@1.1.0').status, 'retired');

    await packageLoader.deactivate('roll_mod', { persist: false });
});

// ── M3: hot-swap ─────────────────────────────────────────────────────────────

test('hot-swap disposes the replaced instance exactly once', async () => {
    globalThis.__hsDisposed = 0;
    const v1 = await buildPackage({
        id: 'swap_mod', version: '1.0.0',
        extraInstanceProps: 'dispose: async () => { globalThis.__hsDisposed++; },',
    });
    const s1 = await packageLoader.verifyAndStage('swap_mod', '1.0.0', { buffer: v1 });
    await packageLoader.activate('swap_mod', '1.0.0', { manifest: s1.manifest, kid: s1.kid, sha256: s1.sha256, entitlement: activeEnt() });

    const v2 = await buildPackage({ id: 'swap_mod', version: '1.1.0' });
    const s2 = await packageLoader.verifyAndStage('swap_mod', '1.1.0', { buffer: v2 });
    await packageLoader.activate('swap_mod', '1.1.0', { manifest: s2.manifest, kid: s2.kid, sha256: s2.sha256, entitlement: activeEnt() });

    // Drain loop is fire-and-forget; no in-flight requests so it resolves fast.
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(globalThis.__hsDisposed, 1, 'old instance disposed once');
    assert.strictEqual(packageLoader._dispatch.get('swap_mod').version, '1.1.0');

    await packageLoader.deactivate('swap_mod', { persist: false });
    delete globalThis.__hsDisposed;
});

test('verifyAndStage flags requiresRestart for native/.node and restart:always packages', async () => {
    const native = await buildPackage({ id: 'nat_mod', version: '1.0.0', extraFiles: { 'server/addon.node': 'binary' } });
    const stagedNative = await packageLoader.verifyAndStage('nat_mod', '1.0.0', { buffer: native });
    assert.strictEqual(stagedNative.requiresRestart, true);

    const always = await buildPackage({ id: 'alw_mod', version: '1.0.0', serverExtra: { restart: 'always' } });
    const stagedAlways = await packageLoader.verifyAndStage('alw_mod', '1.0.0', { buffer: always });
    assert.strictEqual(stagedAlways.requiresRestart, true);

    const plain = await buildPackage({ id: 'plain_mod', version: '1.0.0' });
    const stagedPlain = await packageLoader.verifyAndStage('plain_mod', '1.0.0', { buffer: plain });
    assert.strictEqual(stagedPlain.requiresRestart, false);
});

test('loadInstalledAtBoot completes STAGED updates before wiring the active set', async () => {
    const buf = await buildPackage({ id: 'stage_boot', version: '2.0.0' });
    await packageLoader.verifyAndStage('stage_boot', '2.0.0', { buffer: buf });
    stateRows.set('stage_boot', {
        moduleId: 'stage_boot', status: 'imported', version: '1.0.0',
        settings: { remote: true, manifest: { id: 'stage_boot', capabilities: [] }, entitlement: activeEnt() },
    });
    pkgRows.set('stage_boot@2.0.0', { moduleId: 'stage_boot', version: '2.0.0', status: 'staged', packageSha256: null });

    await packageLoader.loadInstalledAtBoot();
    assert.strictEqual(pkgRows.get('stage_boot@2.0.0').status, 'active', 'staged row completed at boot');
    assert.strictEqual(packageLoader._dispatch.get('stage_boot').version, '2.0.0');
    await packageLoader.deactivate('stage_boot', { persist: false });
});

// ── M1: crash quarantine ────────────────────────────────────────────────────

test('5 crashes in the window quarantine the module durably; reactivate restores it', async () => {
    const buf = await buildPackage({
        id: 'crash_mod', version: '1.0.0',
        entryExtra: `router.get('/boom', () => { throw new Error('kaboom'); });`,
    });
    const staged = await packageLoader.verifyAndStage('crash_mod', '1.0.0', { buffer: buf });
    await packageLoader.activate('crash_mod', '1.0.0', { manifest: staged.manifest, kid: staged.kid, sha256: staged.sha256, entitlement: activeEnt() });

    const express = require('express');
    const app = express();
    app.use('/api/mod', packageLoader.dispatchRouter);
    const server = http.createServer(app);
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        for (let i = 0; i < 5; i++) {
            await fetch(`${base}/api/mod/crash_mod/boom`).catch(() => {});
        }
        // Quarantine fires async off the 5th crash.
        await new Promise(r => setTimeout(r, 200));
        assert.ok(!packageLoader._dispatch.has('crash_mod'), 'runtime deactivated');
        assert.strictEqual(pkgRows.get('crash_mod@1.0.0').status, 'quarantined');
        assert.strictEqual(stateRows.get('crash_mod').status, 'removed', 'persisted off');

        // Operator re-enable: re-verifies, reactivates, resets counters.
        const r = await packageLoader.reactivateModule('crash_mod', { actorId: 'admin1' });
        assert.strictEqual(r.version, '1.0.0');
        assert.ok(packageLoader._dispatch.has('crash_mod'));
        assert.strictEqual(pkgRows.get('crash_mod@1.0.0').status, 'active');
    } finally {
        await new Promise(r => server.close(r));
        await packageLoader.deactivate('crash_mod', { persist: false });
    }
});
