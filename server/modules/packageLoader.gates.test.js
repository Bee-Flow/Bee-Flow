/**
 * packageLoader characterisation: the ORDER of the trust gates and the
 * install / reconcile orchestration, pinned before the loader was split into
 * packageState / packageStaging / packageEntitlement / packageRuntime /
 * packageActivation / packageInstall / packageReconciler behind the
 * packageLoader barrel.
 *
 * Gate order pinned here:
 *   hub install : built-in id conflict → install lease → download → signature
 *                 verify → identity → compat → consent (mv2) → entitlement →
 *                 (staged when a running module needs a restart) → activate
 *   sideload    : signature verify → built-in id conflict → compat → install
 *                 guard → retain + extract → consent → entitlement (offline
 *                 grant → signed license_class free → hub) → activate
 * plus the progress phases, the audit trail, the reconciler (activate /
 * deactivate / self-heal / retention GC), the health snapshot and the exact
 * export surface of the barrel.
 *
 * The fakes go in through the loader's dependency seam
 * (packageState.wireDeps), not through the module cache; signature and grant
 * verification run for real against an ephemeral key. The companion
 * packageLoader.test.js covers the per-function behaviour (verifyAndStage,
 * activate wiring, dispatcher, ticks, rollback, quarantine).
 *
 * Run: node --test modules/packageLoader.gates.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const JSZip = require('jszip');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-at-least-32-chars-long';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'test-master-encryption-key-at-least-32-chars';

// ── Call journal: every fake records into one ordered list ─────────────────
const calls = [];
function journal(name) { return calls.filter(c => c[0] === name); }

const auditEvents = [];
const moduleAudit = {
    emit: async (action, moduleId, actorId, meta) => { auditEvents.push({ action, moduleId, actorId, meta }); },
};

let leaseResult = true;
const installRows = new Map();
const installStore = {
    acquire: async (id, opts) => { calls.push(['lease', id, opts]); return leaseResult; },
    setPhase: async (id, phase, pct, extra) => {
        calls.push(['phase', id, phase, pct]);
        installRows.set(id, { phase, pct, ...extra, replica: 'r1' });
    },
    get: async (id) => installRows.get(id) || null,
};

const stateRows = new Map();
const store = {
    getState: async (id) => (stateRows.get(id) ? { ...stateRows.get(id) } : null),
    setImported: async (id, { actorId = null, version = null, settings = undefined } = {}) => {
        const prev = stateRows.get(id) || {};
        const row = { ...prev, moduleId: id, status: 'imported', version, importedBy: actorId };
        if (settings !== undefined) row.settings = settings;
        stateRows.set(id, row); return { ...row };
    },
    setRemoved: async (id) => {
        const prev = stateRows.get(id) || {};
        const row = { ...prev, moduleId: id, status: 'removed' };
        stateRows.set(id, row); return { ...row };
    },
    mergeSettings: async (id, patch) => {
        calls.push(['mergeSettings', id, patch]);
        const prev = stateRows.get(id); if (!prev) return null;
        prev.settings = { ...(prev.settings || {}), ...patch };
        return { ...prev };
    },
};

const pkgRows = new Map();
const packageStore = {
    setActive: async (id, version, { manifest = null, kid = null, packageSha256 = null, source = null } = {}) => {
        for (const [, r] of pkgRows) { if (r.moduleId === id && r.version !== version && r.status === 'active') r.status = 'retired'; }
        const prev = pkgRows.get(`${id}@${version}`) || {};
        const row = { moduleId: id, version, status: 'active', manifest, kid, packageSha256, source: source || prev.source || 'hub', prunedAt: null, installedBy: null };
        pkgRows.set(`${id}@${version}`, row); return { ...row };
    },
    setStaged: async (id, version, { manifest = null, kid = null, packageSha256 = null, source = null } = {}) => {
        const row = { moduleId: id, version, status: 'staged', manifest, kid, packageSha256, source: source || 'hub', prunedAt: null, installedBy: null };
        pkgRows.set(`${id}@${version}`, row); return { ...row };
    },
    setQuarantined: async () => null,
    setFailed: async (id, version, { error = null, status = 'failed' } = {}) => {
        const row = { moduleId: id, version, status, error };
        pkgRows.set(`${id}@${version}`, row); return { ...row };
    },
    markPruned: async (id, version) => {
        const row = pkgRows.get(`${id}@${version}`);
        if (row) row.prunedAt = 'now';
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
};

const configMap = new Map();
const configStore = {
    getConfig: async (k) => (configMap.has(k) ? configMap.get(k) : null),
    setConfig: async (k, v) => { configMap.set(k, v); return true; },
};

// The module runtime: a module runs while its platform_modules row is imported.
const runtime = {
    isModuleActive: async (id) => !!(stateRows.get(id) && stateRows.get(id).status === 'imported'),
    invalidateCache: () => {},
    refreshModuleActivations: async () => {},
};
const pushedCaps = [];
const registry = {
    getCapability: () => null,
    setRemoteModuleCapabilityDescriptors: (all) => { pushedCaps.splice(0, pushedCaps.length, ...all); },
};
const betaFeatures = { setRemoteBetaFeatures: () => {} };

// ── Fake hub ────────────────────────────────────────────────────────────────
class HubError extends Error {
    constructor(code, message, { status = null, detail = null } = {}) {
        super(message || code); this.name = 'HubError'; this.code = code; this.status = status; this.detail = detail;
    }
}
const hubPackages = new Map();   // `${id}@${version}` → Buffer
const hubGrants = new Map();     // moduleId → grant token
const hubCatalog = new Map();    // moduleId → catalog entry
let hubConnected = true;
const hubClient = {
    HubError,
    isConnected: async () => { calls.push(['hub.isConnected']); return hubConnected; },
    fetchCatalogEntry: async (id) => { calls.push(['hub.fetchCatalogEntry', id]); return hubCatalog.get(id) || null; },
    fetchEntitlements: async () => {
        calls.push(['hub.fetchEntitlements']);
        return { entitlements: [...hubGrants].map(([module_id, grant_token]) => ({ module_id, grant_token, kind: 'subscription' })) };
    },
    downloadPackage: async ({ moduleId, version, destPath, expectedSha256, redownloadSha }) => {
        calls.push(['hub.downloadPackage', moduleId, version, { expectedSha256, redownloadSha }]);
        const buf = hubPackages.get(`${moduleId}@${version}`);
        if (!buf) throw new HubError('hub_unavailable', 'no such package', { status: 404 });
        await fsp.mkdir(path.dirname(destPath), { recursive: true });
        await fsp.writeFile(destPath, buf);
        return { sha256: crypto.createHash('sha256').update(buf).digest('hex') };
    },
};

const packageLoader = require('./packageLoader');
// Inject every collaborator through the loader's dependency seam.
require('./packageState').wireDeps({
    hubClient: () => hubClient,
    store: () => store,
    packageStore: () => packageStore,
    installStore: () => installStore,
    moduleAudit: () => moduleAudit,
    configStore: () => configStore,
    subjects: () => ({ subjectIds: async () => [] }),
    runtime: () => runtime,
    registry: () => registry,
    betaFeatures: () => betaFeatures,
});
// A real built-in catalog id: a hub package may never shadow it.
const BUILTIN_ID = 'automation';

// ── Signing fixtures ────────────────────────────────────────────────────────
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'gates-kid';
const FUTURE = () => Math.floor(Date.now() / 1000) + 3600 * 24;
function sha256hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function signJws(payload) {
    const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWS', kid: KID }));
    const p = b64url(JSON.stringify(payload));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey);
    return `${h}.${p}.${b64url(sig)}`;
}
function makeGrant(moduleId, kind = 'subscription') {
    return signJws({
        iss: 'license.beeflow.nl', aud: 'beeflow-module', token_use: 'module_grant',
        sub: 'inst_x', subject_type: 'license', module_id: moduleId,
        entitlement_id: `ent_${moduleId}`, kind,
        iat: Math.floor(Date.now() / 1000), exp: FUTURE(),
    });
}

async function buildPackage({
    id, version, hostApiVersion = 1, manifestVersion = null, permissions = null,
    licenseClass = null, serverExtra = null, extraFiles = null, extraInstanceProps = '',
}) {
    const manifest = {
        id, name: `Mod ${id}`, version, description: '', category: 'Modules', icon: 'box',
        capabilities: [],
        server: { entry: 'server/index.cjs', host_api_version: hostApiVersion, ...(serverExtra || {}) },
    };
    if (manifestVersion != null) manifest.manifestVersion = manifestVersion;
    if (permissions != null) manifest.permissions = permissions;
    const entrySrc = `
module.exports.createModule = function (hostApi) {
  const router = hostApi.express.Router();
  router.get('/ping', (req, res) => res.json({ pong: true }));
  return { router, initDBs: async () => {}, ${extraInstanceProps} };
};
`;
    const files = new Map();
    files.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
    files.set('server/index.cjs', Buffer.from(entrySrc));
    for (const [name, buf] of Object.entries(extraFiles || {})) files.set(name, Buffer.from(buf));
    const integrity = { algo: 'sha256', files: {} };
    for (const [name, buf] of files) integrity.files[name] = sha256hex(buf);
    const integrityBuf = Buffer.from(JSON.stringify(integrity));
    const jws = signJws({
        iss: 'license.beeflow.nl/modules', module_id: id, version,
        integrity_sha256: sha256hex(integrityBuf), iat: Math.floor(Date.now() / 1000),
        host_api_version: hostApiVersion,
        ...(licenseClass ? { license_class: licenseClass } : {}),
    });
    const zip = new JSZip();
    for (const [name, buf] of files) zip.file(name, buf);
    zip.file('integrity.json', integrityBuf);
    zip.file('signature.jws', Buffer.from(jws));
    return zip.generateAsync({ type: 'nodebuffer' });
}

let dataRoot;
before(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkggates-'));
    packageLoader.__setDataRootForTest(dataRoot);
    packageLoader.__setKeyResolversForTest({ packageResolver: async () => publicKey, grantResolver: async () => publicKey });
});
after(async () => {
    for (const id of [...packageLoader._dispatch.keys()]) await packageLoader.deactivate(id, { persist: false });
    packageLoader.stopReconciler();
    try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch (_) {}
});
beforeEach(() => {
    calls.length = 0; auditEvents.length = 0;
    stateRows.clear(); pkgRows.clear(); configMap.clear(); installRows.clear();
    hubPackages.clear(); hubGrants.clear(); hubCatalog.clear();
    hubConnected = true; leaseResult = true;
});

/** The progress phases one install wrote to the (fake) install store, in order. */
function phasesOf(id) {
    return calls.filter(c => c[0] === 'phase' && c[1] === id).map(c => c.slice(2));
}

// ── Export surface ──────────────────────────────────────────────────────────

test('barrel exports exactly the pre-split keys', () => {
    assert.deepStrictEqual(Object.keys(packageLoader).sort(), [
        'HOST_API_VERSION', '__setDataRootForTest', '__setKeyResolversForTest', '_dispatch',
        'activate', 'activateStaged', 'applyOfflineGrant', 'deactivate', 'dispatchRouter',
        'getInstallProgress', 'getRuntimeHealth', 'installFromHub', 'isInstalling',
        'listVersions', 'loadInstalledAtBoot', 'moduleRoot', 'reactivateModule',
        'reconcileRuntime', 'rollbackTo', 'sideloadFromBuffer', 'startReconciler',
        'stopReconciler', 'updateModule', 'verifyAndStage', 'versionDir',
    ]);
    assert.strictEqual(packageLoader.HOST_API_VERSION, require('./hostApi').HOST_API_VERSION);
    assert.ok(packageLoader._dispatch instanceof Map);
    assert.strictEqual(packageLoader.versionDir('m', '1.0.0'), path.join(dataRoot, 'm', 'versions', '1.0.0'));
    assert.strictEqual(packageLoader.moduleRoot('m'), path.join(dataRoot, 'm'));
    assert.throws(() => packageLoader.versionDir('../x', '1'), /unsafe path segment/);
    assert.throws(() => packageLoader.versionDir('m', 'a/b'), /unsafe path segment/);
});

// ── Hub install: gate order ─────────────────────────────────────────────────

test('hub install: a built-in id is refused before the lease and before the hub', async () => {
    await assert.rejects(() => packageLoader.installFromHub(BUILTIN_ID, { version: '1.0.0' }), (e) => e.code === 'module_id_conflict');
    assert.deepStrictEqual(calls, [], 'no lease, no hub call, no progress');
    assert.strictEqual(packageLoader.isInstalling(BUILTIN_ID), false);
});

test('hub install: a held lease refuses with in-progress before any download', async () => {
    leaseResult = null;
    await assert.rejects(() => packageLoader.installFromHub('lease_mod', { version: '1.0.0' }),
        (e) => e.code === 'already_connected' && e.inProgress === true && e.message === 'install_in_progress');
    assert.deepStrictEqual(calls.map(c => c[0]), ['lease']);
    assert.deepStrictEqual(calls[0][2], { version: '1.0.0', actor: null, replica: packageLoader.getRuntimeHealth().replica });
});

test('hub install: a tampered download fails at verify, before consent and entitlement; ledger failed', async () => {
    const buf = await buildPackage({ id: 'tamp_hub', version: '1.0.0' });
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    hubPackages.set('tamp_hub@1.0.0', buf);
    await assert.rejects(() => packageLoader.installFromHub('tamp_hub', { version: '1.0.0' }), /^Error: package_verify_failed:/);
    assert.strictEqual(journal('hub.fetchEntitlements').length, 0);
    assert.strictEqual(pkgRows.get('tamp_hub@1.0.0').status, 'failed');
    assert.deepStrictEqual(phasesOf('tamp_hub').map(p => p[0]), ['downloading', 'downloading', 'error']);
    assert.strictEqual(packageLoader.isInstalling('tamp_hub'), false, 'guard released');
    const prog = await packageLoader.getInstallProgress('tamp_hub');
    assert.strictEqual(prog.phase, 'error');
    assert.match(prog.error, /^package_verify_failed:/);
});

test('hub install: an incompatible package is ledgered incompatible, entitlement never asked', async () => {
    hubPackages.set('inc_hub@1.0.0', await buildPackage({ id: 'inc_hub', version: '1.0.0', hostApiVersion: 99 }));
    await assert.rejects(() => packageLoader.installFromHub('inc_hub', { version: '1.0.0' }), (e) => e.compat === true);
    assert.strictEqual(journal('hub.fetchEntitlements').length, 0);
    assert.strictEqual(pkgRows.get('inc_hub@1.0.0').status, 'incompatible');
});

test('hub install: consent is checked BEFORE the entitlement gate', async () => {
    hubPackages.set('cons_hub@1.0.0', await buildPackage({ id: 'cons_hub', version: '1.0.0', manifestVersion: 2, hostApiVersion: 3, permissions: ['db'] }));
    await assert.rejects(() => packageLoader.installFromHub('cons_hub', { version: '1.0.0' }),
        (e) => e.code === 'consent_required' && e.missingPermissions.join() === 'db');
    assert.strictEqual(journal('hub.fetchEntitlements').length, 0, 'entitlement never consulted');
    const prog = await packageLoader.getInstallProgress('cons_hub');
    assert.deepStrictEqual(prog, { phase: 'error', pct: null, error: 'consent_required', detail: { missingPermissions: ['db'] } });
    assert.deepStrictEqual(phasesOf('cons_hub').map(p => p[0]), ['downloading', 'downloading', 'verifying', 'error']);
});

test('hub install: consent given but no grant ⇒ not_entitled, nothing activated', async () => {
    hubPackages.set('noent_hub@1.0.0', await buildPackage({ id: 'noent_hub', version: '1.0.0', manifestVersion: 2, hostApiVersion: 3, permissions: ['db'] }));
    await assert.rejects(() => packageLoader.installFromHub('noent_hub', { version: '1.0.0', acceptedPermissions: ['db'] }),
        (e) => e.code === 'not_entitled');
    assert.strictEqual(journal('hub.fetchEntitlements').length, 1);
    assert.ok(!packageLoader._dispatch.has('noent_hub'));
    assert.strictEqual(pkgRows.get('noent_hub@1.0.0').status, 'failed');
    assert.strictEqual(auditEvents.length, 0);
});

test('hub install: full path — catalog → download → verify → consent → entitlement → activate', async () => {
    hubCatalog.set('ok_hub', { module: { latest_version: '1.2.0' } });
    hubPackages.set('ok_hub@1.2.0', await buildPackage({ id: 'ok_hub', version: '1.2.0', manifestVersion: 2, hostApiVersion: 3, permissions: ['db'] }));
    hubGrants.set('ok_hub', makeGrant('ok_hub'));
    const r = await packageLoader.installFromHub('ok_hub', { actorId: 'admin1', acceptedPermissions: ['db'] });
    assert.deepStrictEqual(r, { ok: true, version: '1.2.0', requiresRestart: false });
    assert.deepStrictEqual(
        calls.filter(c => c[0].startsWith('hub.') || c[0] === 'lease').map(c => c[0]),
        ['lease', 'hub.fetchCatalogEntry', 'hub.downloadPackage', 'hub.fetchEntitlements'],
    );
    assert.deepStrictEqual(phasesOf('ok_hub'), [
        ['downloading', 0], ['downloading', 20], ['verifying', 60],
        ['migrating', 75], ['activating', 90], ['done', 100],
    ]);
    assert.deepStrictEqual(auditEvents.map(a => a.action), ['platform.module.install', 'platform.module.consent']);
    assert.deepStrictEqual(auditEvents[0].meta, { version: '1.2.0', permissions: ['db'] });
    const settings = stateRows.get('ok_hub').settings;
    assert.strictEqual(settings.entitlement.kind, 'subscription');
    assert.strictEqual(settings.entitlement.status, 'active');
    assert.deepStrictEqual(settings.grantedPermissions.list, ['db']);
    assert.strictEqual(settings.grantedPermissions.acceptedBy, 'admin1');
    assert.strictEqual(pkgRows.get('ok_hub@1.2.0').status, 'active');
    assert.strictEqual(packageLoader._dispatch.get('ok_hub').version, '1.2.0');
    await packageLoader.deactivate('ok_hub', { persist: false });
});

test('hub update of a RUNNING native module is staged for restart, not hot-swapped', async () => {
    hubPackages.set('nat_hub@1.0.0', await buildPackage({ id: 'nat_hub', version: '1.0.0' }));
    hubPackages.set('nat_hub@1.1.0', await buildPackage({ id: 'nat_hub', version: '1.1.0', extraFiles: { 'server/a.node': 'bin' } }));
    hubGrants.set('nat_hub', makeGrant('nat_hub'));
    await packageLoader.installFromHub('nat_hub', { version: '1.0.0' });
    auditEvents.length = 0;

    hubCatalog.set('nat_hub', { module: { latest_version: '1.1.0' } });
    const r = await packageLoader.updateModule('nat_hub', { actorId: 'admin1' });
    assert.deepStrictEqual(r, { ok: true, version: '1.1.0', requiresRestart: true });
    assert.strictEqual(pkgRows.get('nat_hub@1.1.0').status, 'staged');
    assert.strictEqual(packageLoader._dispatch.get('nat_hub').version, '1.0.0', 'old code keeps running');
    assert.deepStrictEqual(auditEvents.map(a => [a.action, a.meta]), [
        ['platform.module.update', { version: '1.1.0', staged: true }],
    ], 'updateModule does not emit a second update event for a staged update');
    assert.strictEqual((await packageLoader.getInstallProgress('nat_hub')).phase, 'staged');
    await packageLoader.deactivate('nat_hub', { persist: false });
});

test('updateModule hot-activates a pure-JS update and audits it once', async () => {
    hubPackages.set('upd_hub@1.0.0', await buildPackage({ id: 'upd_hub', version: '1.0.0' }));
    hubPackages.set('upd_hub@1.0.1', await buildPackage({ id: 'upd_hub', version: '1.0.1' }));
    hubGrants.set('upd_hub', makeGrant('upd_hub'));
    await packageLoader.installFromHub('upd_hub', { version: '1.0.0' });
    auditEvents.length = 0;
    hubCatalog.set('upd_hub', { module: { latest_version: '1.0.1' } });
    const r = await packageLoader.updateModule('upd_hub', { actorId: 'admin1' });
    assert.deepStrictEqual(r, { ok: true, version: '1.0.1', requiresRestart: false });
    assert.deepStrictEqual(auditEvents.map(a => a.action), ['platform.module.install', 'platform.module.update']);
    assert.strictEqual(pkgRows.get('upd_hub@1.0.0').status, 'retired');
    await packageLoader.deactivate('upd_hub', { persist: false });
});

test('updateModule without a candidate ⇒ hub_unavailable', async () => {
    hubCatalog.set('none_hub', { module: {} });
    await assert.rejects(() => packageLoader.updateModule('none_hub'), (e) => e instanceof HubError && e.code === 'hub_unavailable');
});

// ── Sideload: gate order ────────────────────────────────────────────────────

test('sideload: signature verify comes first (no guard, no progress)', async () => {
    await assert.rejects(() => packageLoader.sideloadFromBuffer(Buffer.from('not a zip')),
        (e) => e.code === 'package_verify_failed' && typeof e.detail === 'string');
    assert.deepStrictEqual(calls, []);
});

test('sideload: built-in id conflict is checked before compat', async () => {
    const buf = await buildPackage({ id: BUILTIN_ID, version: '1.0.0', hostApiVersion: 99 });
    await assert.rejects(() => packageLoader.sideloadFromBuffer(buf), (e) => e.code === 'module_id_conflict');
});

test('sideload: compat is checked before the install guard and before anything is written', async () => {
    const buf = await buildPackage({ id: 'inc_side', version: '1.0.0', hostApiVersion: 99 });
    await assert.rejects(() => packageLoader.sideloadFromBuffer(buf), (e) => e.compat === true);
    assert.deepStrictEqual(calls, []);
    assert.ok(!fs.existsSync(path.join(dataRoot, 'inc_side')));
});

test('sideload: consent precedes entitlement; a consent refusal is NOT ledgered staged', async () => {
    const buf = await buildPackage({ id: 'cons_side', version: '1.0.0', manifestVersion: 2, hostApiVersion: 3, permissions: ['db'] });
    await assert.rejects(() => packageLoader.sideloadFromBuffer(buf), (e) => e.code === 'consent_required');
    assert.strictEqual(pkgRows.size, 0);
    assert.strictEqual(journal('hub.isConnected').length, 0, 'entitlement never consulted');
    assert.ok(fs.existsSync(path.join(dataRoot, 'cons_side', 'pkg', '1.0.0.bfmod')), 'package retained on disk');
    const prog = await packageLoader.getInstallProgress('cons_side');
    assert.deepStrictEqual(prog.detail, { missingPermissions: ['db'] });
});

test('sideload entitlement order: stashed offline grant wins over license_class free', async () => {
    configMap.set('beeflow_hub_offline_grant_ord_side', { grant_token: makeGrant('ord_side', 'admin_granted'), kind: 'admin_granted' });
    const buf = await buildPackage({ id: 'ord_side', version: '1.0.0', licenseClass: 'free' });
    await packageLoader.sideloadFromBuffer(buf, { actorId: 'admin1' });
    const ent = stateRows.get('ord_side').settings.entitlement;
    assert.strictEqual(ent.kind, 'admin_granted');
    assert.strictEqual(ent.source, 'offline');
    assert.ok(ent.grantToken);
    assert.strictEqual(journal('hub.isConnected').length, 0, 'hub never asked');
    assert.deepStrictEqual(auditEvents.map(a => [a.action, a.meta.source]), [['platform.module.install', 'sideload']]);
    await packageLoader.deactivate('ord_side', { persist: false });
});

test('sideload entitlement order: a paid package falls through to the hub when connected', async () => {
    hubGrants.set('hub_side', makeGrant('hub_side'));
    const buf = await buildPackage({ id: 'hub_side', version: '1.0.0' });
    await packageLoader.sideloadFromBuffer(buf);
    assert.deepStrictEqual(calls.filter(c => c[0].startsWith('hub.')).map(c => c[0]), ['hub.isConnected', 'hub.fetchEntitlements']);
    assert.strictEqual(stateRows.get('hub_side').settings.entitlement.kind, 'subscription');
    assert.strictEqual(pkgRows.get('hub_side@1.0.0').source, 'sideload');
    await packageLoader.deactivate('hub_side', { persist: false });
});

test('sideload: disconnected + paid ⇒ offline_grant_required, ledgered staged with source sideload', async () => {
    hubConnected = false;
    const buf = await buildPackage({ id: 'off_side', version: '1.0.0' });
    await assert.rejects(() => packageLoader.sideloadFromBuffer(buf), (e) => e.code === 'offline_grant_required');
    assert.strictEqual(pkgRows.get('off_side@1.0.0').status, 'staged');
    assert.strictEqual(pkgRows.get('off_side@1.0.0').source, 'sideload');
    assert.deepStrictEqual(await packageLoader.getInstallProgress('off_side'), { phase: 'error', pct: null, error: 'offline_grant_required', detail: null });
    await assert.rejects(() => packageLoader.activateStaged('off_side'), (e) => e.code === 'offline_grant_required');
    await assert.rejects(() => packageLoader.activateStaged('nothing_here'), (e) => e.code === 'no_staged_version');
});

// ── Progress fallback ───────────────────────────────────────────────────────

test('getInstallProgress falls back to the install store for another replica', async () => {
    installRows.set('other_rep', { phase: 'downloading', pct: 20, error: null, detail: null, replica: 'r9' });
    assert.deepStrictEqual(await packageLoader.getInstallProgress('other_rep'),
        { phase: 'downloading', pct: 20, error: null, detail: null, replica: 'r9' });
    assert.strictEqual(await packageLoader.getInstallProgress('never_seen'), null);
});

// ── Reconciler + boot self-heal ─────────────────────────────────────────────

function seedActive(id, version, { sha = null, source = 'hub' } = {}) {
    stateRows.set(id, {
        moduleId: id, status: 'imported', version,
        settings: { remote: true, manifest: { id, capabilities: [] }, entitlement: { kind: 'free', status: 'active', exp: FUTURE() } },
    });
    pkgRows.set(`${id}@${version}`, { moduleId: id, version, status: 'active', packageSha256: sha, source, installedBy: null });
}

test('reconcileRuntime activates a ledger-active module and deactivates one that lapsed', async () => {
    await packageLoader.verifyAndStage('rec_a', '1.0.0', { buffer: await buildPackage({ id: 'rec_a', version: '1.0.0' }) });
    seedActive('rec_a', '1.0.0');
    const before = { ...packageLoader.getRuntimeHealth().reconciler };
    await packageLoader.reconcileRuntime();
    let h = packageLoader.getRuntimeHealth();
    assert.ok(packageLoader._dispatch.has('rec_a'));
    assert.strictEqual(h.reconciler.activated, before.activated + 1);
    assert.strictEqual(h.reconciler.lastError, null);
    assert.strictEqual(typeof h.reconciler.lastDurationMs, 'number');

    stateRows.get('rec_a').status = 'removed';
    await packageLoader.reconcileRuntime();
    h = packageLoader.getRuntimeHealth();
    assert.ok(!packageLoader._dispatch.has('rec_a'));
    assert.strictEqual(h.reconciler.deactivated, before.deactivated + 1);
    assert.strictEqual(stateRows.get('rec_a').status, 'removed', 'runtime-only deactivate');
});

test('reconcile retention GC keeps the newest RETENTION_KEEP retired packages', async () => {
    seedActive('gc_mod', '9.0.0');
    for (const v of ['1.0.0', '2.0.0', '3.0.0', '4.0.0', '5.0.0']) {
        const dir = packageLoader.versionDir('gc_mod', v);
        await fsp.mkdir(dir, { recursive: true });
        await fsp.mkdir(path.join(dataRoot, 'gc_mod', 'pkg'), { recursive: true });
        await fsp.writeFile(path.join(dataRoot, 'gc_mod', 'pkg', `${v}.bfmod`), 'x');
        pkgRows.set(`gc_mod@${v}`, { moduleId: 'gc_mod', version: v, status: 'retired', prunedAt: null });
    }
    const stale = path.join(packageLoader.moduleRoot('gc_mod'), 'versions', '9.0.0.tmp-1-1');
    await fsp.mkdir(stale, { recursive: true });
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    await fsp.utimes(stale, old, old);
    stateRows.get('gc_mod').status = 'removed'; // not supposed to run: GC only

    await packageLoader.reconcileRuntime();
    const pruned = [...pkgRows.values()].filter(r => r.moduleId === 'gc_mod' && r.prunedAt).map(r => r.version);
    assert.deepStrictEqual(pruned, ['4.0.0', '5.0.0']);
    assert.ok(!fs.existsSync(path.join(dataRoot, 'gc_mod', 'pkg', '4.0.0.bfmod')));
    assert.ok(!fs.existsSync(packageLoader.versionDir('gc_mod', '5.0.0')));
    assert.ok(fs.existsSync(path.join(dataRoot, 'gc_mod', 'pkg', '1.0.0.bfmod')));
    assert.ok(!fs.existsSync(stale), 'stale tmp dir swept');
});

test('boot self-heal re-downloads the EXACT ledgered sha; sideloaded packages are never healed', async () => {
    const buf = await buildPackage({ id: 'heal_mod', version: '1.0.0' });
    hubPackages.set('heal_mod@1.0.0', buf);
    seedActive('heal_mod', '1.0.0', { sha: sha256hex(buf) });   // no file on disk
    seedActive('side_heal', '1.0.0', { sha: 'abc', source: 'sideload' });

    const res = await packageLoader.loadInstalledAtBoot();
    assert.deepStrictEqual(res, { activated: 1, failed: 1 });
    assert.deepStrictEqual(journal('hub.downloadPackage').map(c => c.slice(1)), [
        ['heal_mod', '1.0.0', { expectedSha256: sha256hex(buf), redownloadSha: sha256hex(buf) }],
    ]);
    assert.ok(packageLoader._dispatch.has('heal_mod'));
    assert.deepStrictEqual(auditEvents.map(a => a.action), ['platform.module.selfheal']);
    assert.strictEqual(pkgRows.get('side_heal@1.0.0').status, 'failed');
    assert.strictEqual(pkgRows.get('side_heal@1.0.0').error, 'package_file_missing');
    const boot = packageLoader.getRuntimeHealth().reconciler.boot;
    assert.strictEqual(boot.activated, 1);
    assert.strictEqual(boot.failed, 1);
    await packageLoader.deactivate('heal_mod', { persist: false });
});

// ── Health snapshot ─────────────────────────────────────────────────────────

test('getRuntimeHealth has the pre-split shape and default limits', () => {
    const h = packageLoader.getRuntimeHealth();
    assert.deepStrictEqual(Object.keys(h), ['replica', 'dispatchedCount', 'reconciler', 'limits', 'modules']);
    assert.strictEqual(h.replica, `${os.hostname()}:${process.pid}`);
    assert.deepStrictEqual(h.limits, { requestTimeoutMs: 30000, crashWindowMs: 600000, crashThreshold: 5, retentionKeep: 3 });
    assert.deepStrictEqual(Object.keys(h.reconciler).sort(), [
        'activated', 'boot', 'deactivated', 'errors', 'gcPruned', 'healed',
        'lastDurationMs', 'lastError', 'lastRunAt', 'running',
    ]);
    assert.strictEqual(h.reconciler.running, false);
    packageLoader.startReconciler();
    assert.strictEqual(packageLoader.getRuntimeHealth().reconciler.running, true);
    packageLoader.stopReconciler();
    assert.strictEqual(packageLoader.getRuntimeHealth().reconciler.running, false);
    // A module that failed activation surfaces in the per-module rows.
    assert.ok(h.modules.tamp_hub || h.modules.noent_hub, 'install failures recorded in health');
    const row = h.modules.noent_hub;
    assert.deepStrictEqual(Object.keys(row), [
        'running', 'version', 'crashesInWindow', 'lastActivationError', 'disposeTimeouts',
        'restartAdvised', 'capabilityConflicts', 'healTerminal',
    ]);
    assert.strictEqual(row.running, false);
    assert.match(row.lastActivationError, /not_entitled|no entitlement/);
});
