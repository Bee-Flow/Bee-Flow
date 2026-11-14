// @typecheck
'use strict';

/**
 * Characterisation (golden) test for activate(): for each scenario the
 * result or the thrown error (message, code, missing permissions), every call
 * it makes on its collaborators in order (stores, capability registry, beta
 * features, hostApi factory, runtime, log buffer, the module's own hooks and
 * the onPhase callback), and what it leaves behind (dispatch entry,
 * descriptors, health conflicts, tick). Scenarios reach each branch: the entry
 * path (missing, escaping), the mv2 permission check (granted in the call, in
 * the stored row, a failing read, missing), capability conflicts at install
 * and at boot, every way loading the module can fail and what it cleans up,
 * migrations, the gate-capability fallbacks, a hot swap, the tick interval and
 * the persisted settings (with and without a readable stored row).
 *
 * The collaborators are wired through packageState.wireDeps (the loader's own
 * injection point); module code is real files in a temporary data root.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test modules/packageActivation.activate.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const state = require('./packageState');
const { activate } = require('./packageActivation');
const { _stopTick } = require('./packageRuntime');

const GOLDEN = path.join(__dirname, 'packageActivation.activate.characterisation.golden.json');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-activate-char-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
state.__setDataRootForTest(ROOT);

/** @type {unknown[][]} */
let calls = [];
/** @type {Record<string, any>} */
let env = {};
/** Machine paths out: the data root and the server directory. @param {string} text */
const unroot = (text) => text.split(ROOT).join('<root>').split(path.resolve(__dirname, '..')).join('<server>');
const rel = (/** @type {unknown} */ v) => JSON.parse(unroot(JSON.stringify(v ?? null)));
const record = (/** @type {unknown[]} */ ...c) => { calls.push(rel(c)); };
/** @type {any} */ (globalThis).__activateCharRecord = record;

state.wireDeps({
    store: () => ({
        getState: async (/** @type {string} */ id) => { record('store.getState', id); if (env.stateThrows) throw new Error('db down'); return env.state ?? null; },
        setImported: async (/** @type {string} */ id, /** @type {unknown} */ a) => { record('store.setImported', id, a); },
    }),
    packageStore: () => ({ setActive: async (/** @type {string[]} */ ...a) => { record('packageStore.setActive', ...a); } }),
    registry: () => ({
        getCapability: (/** @type {string} */ id) => {
            record('registry.getCapability', id);
            if (env.registryThrows) throw new Error('registry not ready');
            return env.owners && env.owners[id] ? { id, moduleId: env.owners[id] === '<self>' ? env.selfId : env.owners[id] } : null;
        },
        setRemoteModuleCapabilityDescriptors: (/** @type {any[]} */ list) => { record('registry.setRemote', list.map((d) => `${d.moduleId}:${d.id}:${d.kind}`)); },
    }),
    betaFeatures: () => ({ setRemoteBetaFeatures: (/** @type {any[]} */ list) => { record('beta.setRemote', list.map((d) => d.id)); } }),
    hostApiFactory: () => ({
        build: (/** @type {string} */ id, /** @type {unknown} */ o) => { record('hostApi.build', id, o); return { tag: `hostApi of ${id}` }; },
        requireCapability: (/** @type {string} */ cap) => { record('hostApi.requireCapability', cap); return () => {}; },
    }),
    runtime: () => ({
        invalidateCache: () => { record('runtime.invalidateCache'); },
        refreshModuleActivations: async () => { record('runtime.refreshModuleActivations'); },
        isModuleActive: async () => false,
    }),
    logBuffer: () => ({ append: (/** @type {string} */ id, /** @type {string} */ kind, /** @type {string[]} */ lines) => { record('log', id, kind, lines); } }),
    moduleAudit: () => ({ emit: async (/** @type {unknown[]} */ ...a) => { record('audit', ...a); } }),
});

/**
 * Module source for a fixture: what createModule does, which hooks it has.
 * @param {Record<string, any>} m
 */
function moduleSource(m) {
    if (m.kind === 'noCreate') return 'module.exports = { other: 1 };';
    if (m.kind === 'requireThrows') return 'throw new Error("syntax-ish failure at load");';
    if (m.kind === 'nullExport') return 'module.exports = null;';
    const hooks = [
        m.noRouter ? '' : 'router: function router() {},',
        m.initDBs ? `initDBs: async () => { rec('initDBs'); ${m.initDBs === 'throw' ? 'throw new Error("migration 3 failed");' : ''} },` : '',
        m.tick ? 'tick: async () => {},' : '',
        m.tickIntervalMs !== undefined ? `tickIntervalMs: ${JSON.stringify(m.tickIntervalMs)},` : '',
    ].join('\n');
    return `const rec = (...a) => globalThis.__activateCharRecord(...a);
module.exports = { createModule: async (hostApi) => {
    rec('createModule', hostApi.tag);
    ${m.kind === 'createThrows' ? 'throw new Error("create blew up");' : ''}
    ${m.kind === 'createNull' ? 'return null;' : ''}
    return { ${hooks} };
} };`;
}

const cap = (/** @type {string} */ id, /** @type {Record<string, unknown>} */ o = {}) => ({ id, ...o });
const mv1 = (/** @type {Record<string, any>} */ o = {}) => ({ id: 'm', name: 'Mod', version: '1.0.0', server: { entry: 'index.js' }, capabilities: [cap('m_cap')], ...o });
const mv2 = (/** @type {Record<string, any>} */ o = {}) => mv1({ manifestVersion: 2, permissions: ['kb.read', 'mail.send'], ...o });

/**
 * again: activate a second time after the module file changed (the require cache must not serve the old code).
 * @typedef {{ manifest?: any, opts?: Record<string, any>, module?: Record<string, any>, env?: Record<string, any>, again?: Record<string, any>, noFile?: boolean, writeManifest?: boolean }} Scenario
 * @type {Record<string, Scenario>}
 */
const SCENARIOS = {
    plainMv1: { manifest: mv1(), opts: { actorId: 'a1', kid: 'k1', sha256: 'abc', entitlement: { plan: 'pro' }, source: 'hub' } },
    manifestFromDisk: { writeManifest: true, opts: { persist: false } },
    noEntry: { manifest: mv1({ server: {} }) },
    noServer: { manifest: mv1({ server: undefined }) },
    entryEscapes: { manifest: mv1({ server: { entry: '../../evil.js' } }) },
    entryIsDir: { manifest: mv1({ server: { entry: '.' } }) },
    mv2GrantedInCall: { manifest: mv2(), opts: { grantedPermissions: { list: ['kb.read', 'mail.send', 'extra'] } } },
    mv2GrantedInStore: { manifest: mv2(), env: { state: { settings: { grantedPermissions: { list: ['kb.read', 'mail.send'] } } } } },
    mv2MissingSome: { manifest: mv2(), opts: { grantedPermissions: { list: ['kb.read'] } } },
    mv2EmptyGrantObject: { manifest: mv2(), opts: { grantedPermissions: { list: [] } }, env: { state: { settings: { grantedPermissions: { list: ['kb.read', 'mail.send'] } } } } },
    mv2StoreThrows: { manifest: mv2(), env: { stateThrows: true } },
    mv2StoreRowNoSettings: { manifest: mv2(), env: { state: { settings: null } } },
    mv2NoPermissions: { manifest: mv2({ permissions: [] }) },
    mv2PermissionsNotList: { manifest: mv2({ permissions: 'kb.read' }) },
    mv3: { manifest: mv2({ manifestVersion: '3' }), opts: { grantedPermissions: { list: ['kb.read', 'mail.send'] }, persist: false } },
    conflictAtInstall: { manifest: mv1({ capabilities: [cap('m_cap'), cap('taken', { kind: 'beta' })] }), env: { owners: { taken: 'other' } } },
    conflictAtBoot: { manifest: mv1({ capabilities: [cap('m_cap', { kind: 'beta' }), cap('taken', { kind: 'beta' }), cap('own')] }), env: { owners: { taken: 'other', own: '<self>' } }, opts: { persist: false } },
    registryThrows: { manifest: mv1(), env: { registryThrows: true }, opts: { persist: false } },
    coreKindCap: { manifest: mv1({ capabilities: [cap('c1', { kind: 'core' }), null, cap(''), cap('b1', { kind: 'beta', lifecycle: 'preview' })] }), opts: { persist: false } },
    requireFails: { noFile: true },
    requireThrows: { module: { kind: 'requireThrows' } },
    nullExport: { module: { kind: 'nullExport' } },
    noCreateModule: { module: { kind: 'noCreate' } },
    createThrows: { module: { kind: 'createThrows' } },
    createNull: { module: { kind: 'createNull' } },
    noRouter: { module: { noRouter: true } },
    initDBsOk: { module: { initDBs: 'ok' }, opts: { onPhase: true } },
    initDBsThrows: { module: { initDBs: 'throw' }, opts: { onPhase: true } },
    onPhaseNoInit: { opts: { onPhase: true, persist: false } },
    gateOverride: { manifest: mv1({ gateCapability: 'm_cap', capabilities: [cap('x'), cap('m_cap')] }), opts: { persist: false } },
    gateStudioApp: { manifest: mv1({ frontend: { studioApp: { gateCapability: 'm_cap' }, gateCapability: 'x' }, capabilities: [cap('x'), cap('m_cap')] }), opts: { persist: false } },
    gateFrontend: { manifest: mv1({ frontend: { gateCapability: 'm_cap' }, capabilities: [cap('x'), cap('m_cap')] }), opts: { persist: false } },
    gateFirstCap: { manifest: mv1({ capabilities: [cap('first'), cap('second')] }), opts: { persist: false } },
    gateNotOwn: { manifest: mv1({ gateCapability: 'someone_else', capabilities: [cap('mine')] }), opts: { persist: false } },
    gateNotOwnNoCaps: { manifest: mv1({ gateCapability: 'someone_else', capabilities: undefined }), opts: { persist: false } },
    gateNone: { manifest: mv1({ capabilities: [] }), opts: { persist: false } },
    gateFirstCapNoId: { manifest: mv1({ capabilities: [{ name: 'x' }, cap('y')] }), opts: { persist: false } },
    routes: { manifest: mv1({ server: { entry: 'index.js', streamingRoutes: ['/sse'], publicRoutes: ['/hook'] } }), opts: { persist: false } },
    routesNotLists: { manifest: mv1({ server: { entry: 'index.js', streamingRoutes: '/sse', publicRoutes: '/hook' } }), opts: { persist: false } },
    hotSwap: { env: { oldEntry: true }, opts: { persist: false } },
    tickDefault: { module: { tick: true }, opts: { persist: false } },
    tickCustom: { module: { tick: true, tickIntervalMs: 5000 }, opts: { persist: false } },
    tickBadInterval: { module: { tick: true, tickIntervalMs: 'soon' }, opts: { persist: false } },
    intervalWithoutTick: { module: { tickIntervalMs: 5000 }, opts: { persist: false } },
    persistKeepsStored: { env: { state: { settings: { entitlement: { plan: 'stored' }, grantedPermissions: { list: ['x'] } } } }, opts: { actorId: 'a2', version: 'ignored' } },
    persistCallWins: { env: { state: { settings: { entitlement: { plan: 'stored' }, grantedPermissions: { list: ['x'] } } } }, opts: { entitlement: { plan: 'call' }, grantedPermissions: { list: ['y'] } } },
    persistStoreThrowsNothingPassed: { env: { stateThrows: true } },
    persistStoreThrowsOnlyEntitlement: { env: { stateThrows: true }, opts: { entitlement: { plan: 'call' } } },
    persistStoreThrowsBothPassed: { env: { stateThrows: true }, opts: { entitlement: { plan: 'call' }, grantedPermissions: { list: [] } } },
    persistNoRow: { env: { state: null } },
    reloadsChangedCode: { module: { tick: true }, opts: { persist: false }, again: { initDBs: 'ok' } },
};

/** @param {string} id @param {Scenario} sc */
function prepare(id, sc) {
    const dir = path.join(ROOT, id, 'versions', '1.0.0');
    fs.mkdirSync(dir, { recursive: true });
    if (!sc.noFile) fs.writeFileSync(path.join(dir, 'index.js'), moduleSource(sc.module || {}));
    if (sc.writeManifest) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(mv1({ id })));
}

/** @param {string} id */
function leftBehind(id) {
    const e = state._dispatch.get(id);
    return rel({
        dispatch: e ? {
            moduleId: e.moduleId, version: e.version, gateCapability: e.gateCapability, dir: e.dir, inflight: e.inflight, draining: e.draining,
            streamingRoutes: e.streamingRoutes, publicRoutes: e.publicRoutes, handle: typeof e.handle, router: typeof e.router,
            instanceKeys: Object.keys(e.instance || {}).sort(), keys: Object.keys(e),
        } : null,
        descriptors: state._remoteDescriptors.get(id) || null,
        health: state._moduleHealth.has(id) ? state._moduleHealth.get(id) : null,
        dataDir: fs.existsSync(path.join(ROOT, id, 'data')),
        tick: state._ticks.has(id),
        // Node's Timeout keeps its interval as _idleTimeout.
        tickMs: state._ticks.has(id) ? /** @type {any} */ (state._ticks.get(id))._idleTimeout : null,
    });
}

/** @param {string} id @param {Scenario} sc */
async function runScenario(id, sc) {
    calls = [];
    env = { ...(sc.env || {}), selfId: id };
    prepare(id, sc);
    if (env.oldEntry) {
        state._dispatch.set(id, /** @type {any} */ ({ moduleId: id, version: '0.9.0', instance: {}, inflight: 0, draining: false }));
    }
    const opts = { ...(sc.opts || {}) };
    if (opts.onPhase) opts.onPhase = (/** @type {string} */ phase, /** @type {number} */ pct) => record('onPhase', phase, pct);
    const args = { ...opts, ...(sc.writeManifest ? {} : { manifest: { ...(sc.manifest || mv1()), id } }) };
    /** @type {Record<string, unknown>} */
    let outcome;
    try {
        if (sc.again) {
            await activate(id, '1.0.0', args);
            fs.writeFileSync(path.join(ROOT, id, 'versions', '1.0.0', 'index.js'), moduleSource(sc.again));
        }
        outcome = { result: await activate(id, '1.0.0', args) };
    } catch (e) {
        const err = /** @type {Error & { code?: string, missingPermissions?: string[] }} */ (e);
        outcome = { error: { message: unroot(err.message), code: err.code ?? null, missingPermissions: err.missingPermissions ?? null } };
    }
    const after = leftBehind(id);
    _stopTick(id);
    state._dispatch.delete(id);
    state._remoteDescriptors.delete(id);
    state._moduleHealth.delete(id);
    return { ...outcome, calls, ...after };
}

test('activate: every scenario matches the golden result', async () => {
    /** @type {Record<string, unknown>} */
    const actual = {};
    for (const [name, sc] of Object.entries(SCENARIOS)) actual[name] = await runScenario(`char_${name}`, sc);
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual), Object.keys(golden));
    for (const name of Object.keys(actual)) assert.deepEqual(actual[name], golden[name], name);
});

test('a reactivated version without a tick stops the tick of the version it replaces', async () => {
    const out = await runScenario('char_tick_dropped', { module: { tick: true }, opts: { persist: false }, again: {} });
    assert.equal(out.tick, false, 'the old instance is disposed; its timer must not keep calling it');
});
