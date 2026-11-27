/**
 * modules/firstParty/loader.js with injected dependencies: discovery, the three states, the
 * requires order, the order index, and the isolation of every step (a module that throws fails
 * alone). The core-mode run on a fixture tree is loader.coreMode.test.js; the real tree is
 * compositions.test.js.
 */

'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert');
const loader = require('./loader');
const moduleState = require('./moduleState');

/** A log that records its calls. */
function recordingLog() {
    /** @type {Array<[string, string]>} */
    const calls = [];
    const at = (/** @type {string} */ level) => (/** @type {unknown[]} */ ...args) => { calls.push([level, args.map(String).join(' ')]); };
    return { calls, info: at('info'), warn: at('warn'), error: at('error') };
}

/**
 * Loader deps over a virtual firstParty/ directory: each value is a composition, or a function
 * that is called instead of requiring (to throw). `extra` adds file names that are not
 * compositions.
 * @param {Record<string, unknown>} comps
 * @param {{ extra?: string[], unavailable?: string[], order?: object }} [opts]
 */
function depsFor(comps, opts = {}) {
    const log = recordingLog();
    const names = [...Object.keys(comps).map((id) => `${id}.js`), ...(opts.extra || [])];
    return {
        log,
        listTreeDir: (/** @type {string} */ dir) => {
            assert.strictEqual(dir, 'firstParty');
            return names.map((name) => ({ name, abs: `/tree/firstParty/${name}` }));
        },
        catalog: { isModuleAvailable: (/** @type {string} */ id) => !(opts.unavailable || []).includes(id) },
        require: (/** @type {string} */ file) => {
            const id = file.slice('/tree/firstParty/'.length, -'.js'.length);
            const c = comps[id];
            return typeof c === 'function' ? c() : c;
        },
        order: opts.order,
    };
}

/** A fake express app or router that records its use() calls. */
function fakeApp() {
    /** @type {unknown[][]} */
    const uses = [];
    return { uses, use: (/** @type {unknown[]} */ ...args) => { uses.push(args); } };
}

/** @param {string} name */
const named = (name) => Object.defineProperty(() => {}, 'name', { value: name });

/** id -> state, from modules() */
const states = () => Object.fromEntries(loader.modules().map((m) => [m.id, m.state]));
/** id -> detail, from modules() */
const details = () => Object.fromEntries(loader.modules().filter((m) => m.detail).map((m) => [m.id, m.detail]));

const GATES = /** @type {any} */ ({ requireModule: (/** @type {string} */ id) => named(`requireModule(${id})`) });

beforeEach(() => loader._resetLoaderForTests());

describe('load: discovery and states', () => {
    test('every <id>.js is a composition; part files and tests are not; all loaded, empty', () => {
        const deps = depsFor({ a: { id: 'a' }, b: { id: 'b', requires: ['a'], uses: ['c'] } },
            { extra: ['a.mounts.js', 'a.test.js', 'README.md', 'b.jobs.js'] });
        const got = loader.load(deps);
        assert.deepStrictEqual(got, [
            { id: 'a', state: 'loaded', requires: [], uses: [] },
            { id: 'b', state: 'loaded', requires: ['a'], uses: ['c'] },
        ]);
        assert.strictEqual(moduleState.moduleStateOf('b'), 'loaded');
        assert.deepStrictEqual(deps.log.calls, []);
    });

    test('load() is idempotent: the second call returns the first outcome', () => {
        loader.load(depsFor({ a: { id: 'a' } }));
        assert.deepStrictEqual(loader.load(depsFor({ z: { id: 'z' } })).map((m) => m.id), ['a']);
    });

    test('an id the catalog marks unavailable is absent and never required', () => {
        let required = false;
        loader.load(depsFor({ a: () => { required = true; return { id: 'a' }; }, b: { id: 'b' } }, { unavailable: ['a'] }));
        assert.strictEqual(required, false);
        assert.deepStrictEqual(states(), { a: 'absent', b: 'loaded' });
        assert.strictEqual(moduleState.moduleStateOf('a'), 'absent');
    });

    test('a composition that throws, or that breaks the contract, fails with a detail; the others load', () => {
        const deps = depsFor({
            a: () => { throw new Error('syntax'); },
            b: { id: 'other' },
            c: { id: 'c', mounts: [{ key: 'c:x', slot: 'late', path: '/x', handlers: () => [] }] },
            d: { id: 'd' },
        });
        loader.load(deps);
        assert.deepStrictEqual(states(), { a: 'failed', b: 'failed', c: 'failed', d: 'loaded' });
        assert.deepStrictEqual(details(), {
            a: 'its composition threw while loading: syntax',
            b: 'its id "other" is not the file name "b"',
            c: 'mounts[0]: slot "late" is not one of static, early, main, fallback',
        });
        assert.strictEqual(moduleState.moduleStateOf('a'), 'failed');
        assert.strictEqual(deps.log.calls.filter(([level]) => level === 'error').length, 3);
    });

    test('requires on a failed or missing module fails, transitively; on one this edition leaves out, it is absent too', () => {
        loader.load(depsFor({
            a: { id: 'a', requires: ['gone'] },
            b: { id: 'b', requires: ['a'] },
            c: () => { throw new Error('x'); },
            d: { id: 'd', requires: ['c'] },
            e: { id: 'e', requires: ['u'], provides: { featureModules: ['e/thing'] } },
            f: { id: 'f', requires: ['e'] },
            u: { id: 'u' },
        }, { unavailable: ['u'] }));
        assert.deepStrictEqual(states(), { a: 'failed', b: 'failed', c: 'failed', d: 'failed', e: 'absent', f: 'absent', u: 'absent' });
        assert.deepStrictEqual(details(), {
            a: 'it requires "gone", which is absent',
            b: 'it requires "a", which failed',
            c: 'its composition threw while loading: x',
            d: 'it requires "c", which failed',
            e: 'it requires "u", which is not available in this edition',
            f: 'it requires "e", which is not available in this edition',
            u: 'not available in this edition',
        });
        assert.strictEqual(moduleState.moduleStateOf('e'), 'absent');
        assert.doesNotThrow(() => moduleState.assertProviderNotFailed('featureModules', 'e/thing'), 'an absent module\'s name answers absent');
    });

    test('a requires cycle fails every module on it', () => {
        loader.load(depsFor({ a: { id: 'a', requires: ['b'] }, b: { id: 'b', requires: ['a'] }, c: { id: 'c' } }));
        assert.deepStrictEqual(states(), { a: 'failed', b: 'failed', c: 'loaded' });
        assert.match(details().a, /requires cycle \(a, b\)/);
    });

    test('a row key is "<id>:<name>" and used once: another module\'s prefix, or a key twice, fails', () => {
        const row = { key: 'a:x', slot: 'main', path: '/x', handlers: () => [named('r')] };
        loader.load(depsFor({
            a: { id: 'a', mounts: [row] },
            b: { id: 'b', jobs: [{ key: 'a:x', phase: 'startSeatSync', start() {} }] },
            c: { id: 'c', mounts: [{ ...row, key: 'c:x' }], jobs: [{ key: 'c:x', phase: 'startSeatSync', start() {} }] },
        }));
        assert.deepStrictEqual(states(), { a: 'loaded', b: 'failed', c: 'failed' });
        assert.deepStrictEqual(details(), { b: 'jobs[0]: key "a:x" is not "b:<name>"', c: 'row key "c:x" is already used by module "c"' });
    });

    test('provides are declared before module code runs: a failed module\'s names throw, never look absent', () => {
        loader.load(depsFor({
            a: { id: 'a', requires: ['gone'], provides: { featureModules: ['aFeature'] } },
            b: { id: 'b', provides: { featureModules: ['aFeature'] } },
        }));
        assert.deepStrictEqual(states(), { a: 'failed', b: 'failed' });
        assert.match(details().b, /declared by "a" and "b"/);
        assert.throws(() => moduleState.assertProviderNotFailed('featureModules', 'aFeature'), { code: 'MODULE_FAILED' });
    });
});

describe('mount and mountAi', () => {
    const row = (/** @type {string} */ key, /** @type {string} */ slot, /** @type {object} */ extra = {}) => ({
        key, slot, path: `/${key.split(':')[1]}`, handlers: (/** @type {any} */ g) => [g.requireModule(key), named(`router(${key})`)], ...extra,
    });
    /** @param {unknown[][]} uses */
    const summary = (uses) => uses.map((args) => args.map((a) => (typeof a === 'function' ? a.name : a)).join(' '));

    test('each slot gets its own rows: listed keys first, then unlisted by module id and row order', () => {
        loader.load(depsFor({
            b: { id: 'b', mounts: [row('b:one', 'main'), row('b:two', 'main'), row('b:static', 'static')] },
            a: { id: 'a', mounts: [row('a:one', 'main'), row('a:fb', 'fallback', { path: null })] },
            c: { id: 'c', mounts: [row('c:one', 'main')] },
        }, { order: { mounts: ['c:one', 'b:two'] } }));
        const app = fakeApp();
        loader.mount(app, GATES, 'static');
        loader.mount(app, GATES, 'early');
        loader.mount(app, GATES, 'main');
        loader.mount(app, GATES, 'fallback');
        assert.deepStrictEqual(summary(app.uses), [
            '/static requireModule(b:static) router(b:static)',
            '/one requireModule(c:one) router(c:one)',
            '/two requireModule(b:two) router(b:two)',
            '/one requireModule(a:one) router(a:one)',
            '/one requireModule(b:one) router(b:one)',
            'requireModule(a:fb) router(a:fb)',
        ]);
    });

    test('when() false skips a row; onMount gets the log after the mount', () => {
        const deps = depsFor({ a: { id: 'a', mounts: [
            row('a:off', 'main', { when: () => false }),
            row('a:on', 'main', { when: () => true, onMount: (/** @type {any} */ log) => log.info('[Server] a mounted') }),
        ] } });
        loader.load(deps);
        const app = fakeApp();
        loader.mount(app, GATES, 'main');
        assert.deepStrictEqual(summary(app.uses), ['/on requireModule(a:on) router(a:on)']);
        assert.deepStrictEqual(deps.log.calls, [['info', '[Server] a mounted']]);
    });

    test('a row that throws fails only its module (and what requires it); the other rows mount', () => {
        const deps = depsFor({
            a: { id: 'a', mounts: [row('a:bad', 'main', { handlers: () => { throw new Error('no router'); } }), row('a:later', 'main')] },
            b: { id: 'b', requires: ['a'], mounts: [row('b:x', 'main')] },
            c: { id: 'c', mounts: [row('c:x', 'main'), row('c:empty', 'main', { handlers: () => [] })] },
            d: { id: 'd', mounts: [row('d:x', 'main')] },
        });
        loader.load(deps);
        const app = fakeApp();
        loader.mount(app, GATES, 'main');
        assert.deepStrictEqual(summary(app.uses), ['/x requireModule(c:x) router(c:x)', '/x requireModule(d:x) router(d:x)']);
        assert.deepStrictEqual(states(), { a: 'failed', b: 'failed', c: 'failed', d: 'loaded' });
        assert.deepStrictEqual(details(), {
            a: 'mount "a:bad" threw: no router',
            b: 'it requires "a", which failed',
            c: 'mount "c:empty" threw: handlers(gates) did not return a list of middleware',
        });
        assert.strictEqual(moduleState.moduleStateOf('a'), 'failed');
    });

    test('an unknown slot is a programming error of the core', () => {
        loader.load(depsFor({}));
        assert.throws(() => loader.mount(fakeApp(), GATES, /** @type {any} */ ('late')), /unknown slot "late"/);
    });

    test('mountAi mounts the aiMounts rows on the router, in order-index order', () => {
        loader.load(depsFor({
            l: { id: 'l', aiMounts: [{ key: 'l:/learning', path: '/learning', handlers: () => [named('learning')] },
                { key: 'l:/learning/admin', path: '/learning/admin', handlers: () => [named('learningAdmin')] }] },
            n: { id: 'n', aiMounts: [{ key: 'n:gate', path: null, handlers: () => [named('notebookGate')] }] },
        }, { order: { aiMounts: ['n:gate', 'l:/learning/admin'] } }));
        const router = fakeApp();
        loader.mountAi(router, GATES);
        assert.deepStrictEqual(summary(router.uses), ['notebookGate', '/learning/admin learningAdmin', '/learning learning']);
    });
});

describe('register and afterListen', () => {
    test('register() runs in requires order; a throw fails that module and its dependents only', () => {
        /** @type {string[]} */
        const ran = [];
        const deps = depsFor({
            apps: { id: 'apps', requires: ['automation'], register: () => ran.push('apps') },
            automation: { id: 'automation', requires: ['datatables'], register: () => ran.push('automation') },
            datatables: { id: 'datatables', register: () => ran.push('datatables') },
            bad: { id: 'bad', register: () => { throw new Error('registry clash'); } },
            needsBad: { id: 'needsBad', requires: ['bad'], register: () => ran.push('needsBad') },
        });
        loader.load(deps);
        loader.register();
        assert.deepStrictEqual(ran, ['datatables', 'automation', 'apps']);
        assert.strictEqual(states().bad, 'failed');
        assert.strictEqual(states().needsBad, 'failed');
        assert.strictEqual(details().bad, 'register() threw: registry clash');
    });

    test('afterListen gets the app, the server and the context', () => {
        /** @type {unknown[]} */
        const seen = [];
        loader.load(depsFor({ w: { id: 'w', afterListen: (/** @type {unknown[]} */ ...args) => seen.push(...args) } }));
        const app = /** @type {any} */ ({});
        const server = /** @type {any} */ ({});
        const ctx = { terminalErrorHandler: () => {} };
        loader.afterListen(app, server, ctx);
        assert.deepStrictEqual(seen, [app, server, ctx]);
    });
});

describe('runStartupPhase', () => {
    test('starts the rows of that phase only, in order-index order, each isolated, with the context', () => {
        /** @type {unknown[]} */
        const ran = [];
        const job = (/** @type {string} */ key, /** @type {string} */ phase, /** @type {object} */ extra = {}) => ({
            key, phase, start: (/** @type {unknown} */ ctx) => { ran.push([key, ctx]); }, ...extra,
        });
        const deps = depsFor({
            a: { id: 'a', jobs: [job('a:1', 'startRunnersAndFeeds'), job('a:other', 'startSeatSync')] },
            b: { id: 'b', jobs: [job('b:1', 'startRunnersAndFeeds', { label: 'B sync', start: () => { throw new Error('boom'); } }), job('b:2', 'startRunnersAndFeeds')] },
        }, { order: { jobs: ['b:2'] } });
        loader.load(deps);
        loader.runStartupPhase('startRunnersAndFeeds', 'ctx');
        assert.deepStrictEqual(ran, [['b:2', 'ctx'], ['a:1', 'ctx']]);
        assert.deepStrictEqual(deps.log.calls, [['warn', '[Server] B sync load failed: boom']]);
        assert.deepStrictEqual(states(), { a: 'loaded', b: 'loaded' });
    });

    test('a module that failed starts no job; an unknown phase throws', () => {
        let started = false;
        loader.load(depsFor({ a: { id: 'a', register: () => { throw new Error('x'); }, jobs: [{ key: 'a:j', phase: 'startSeatSync', start: () => { started = true; } }] } }));
        loader.register();
        loader.runStartupPhase('startSeatSync');
        assert.strictEqual(started, false);
        assert.throws(() => loader.runStartupPhase(/** @type {any} */ ('startLater')), /unknown phase/);
    });
});

describe('drain and close', () => {
    test('drain runs every module that loaded in parallel, each bounded, and never rejects', async () => {
        /** @type {string[]} */
        const done = [];
        const deps = depsFor({
            fast: { id: 'fast', drain: async (/** @type {any} */ o) => { done.push(`fast:${o.timeoutMs}`); } },
            hangs: { id: 'hangs', drain: () => new Promise(() => {}) },
            throws: { id: 'throws', drain: () => { throw new Error('drain bug'); } },
            failedLater: { id: 'failedLater', register: () => { throw new Error('x'); }, drain: async () => { done.push('failedLater'); } },
            neverLoaded: { id: 'neverLoaded', requires: ['gone'], drain: async () => { done.push('neverLoaded'); } },
        });
        loader.load(deps);
        loader.register();
        const started = Date.now();
        await loader.drain({ timeoutMs: 40 });
        assert.ok(Date.now() - started < 1000);
        assert.deepStrictEqual(done.sort(), ['failedLater', 'fast:40']);
        const warns = deps.log.calls.filter(([level]) => level === 'warn').map(([, text]) => text).sort();
        assert.deepStrictEqual(warns, ['[Server] module hangs drain did not finish within 40 ms', '[Server] module throws drain failed: drain bug']);
    });

    test('close has a default bound and the same isolation', async () => {
        /** @type {unknown[]} */
        const seen = [];
        loader.load(depsFor({ a: { id: 'a', close: async (/** @type {unknown} */ o) => { seen.push(o); } }, b: { id: 'b', close: () => Promise.reject(new Error('no')) } }));
        await loader.close();
        assert.deepStrictEqual(seen, [{ timeoutMs: 10_000 }]);
    });
});

describe('stores, migrations and nlTranslations', () => {
    test('the core order index decides, also against the requires order (datatableStore after automationStore)', () => {
        loader.load(depsFor({
            automation: { id: 'automation', requires: ['datatables'], stores: [{ name: 'automationStore', file: './stores/automationStore' }], migrations: ['routine-to-automation'] },
            datatables: { id: 'datatables', stores: [{ name: 'datatableStore', file: './stores/datatableStore' }, { name: 'datatableDbStore', file: './stores/datatableDbStore' }], nlTranslations: ['add-nl-datatables'] },
            apps: { id: 'apps', stores: [{ name: 'studioAppStore', file: './stores/studioAppStore' }], migrations: ['apps-mig'], nlTranslations: ['add-nl-apps'] },
            gone: { id: 'gone', requires: ['nowhere'], stores: [{ name: 'goneStore', file: './stores/goneStore' }] },
        }, { order: { stores: ['automationStore', 'datatableStore'], migrations: ['routine-to-automation'], nlTranslations: ['add-nl-datatables'] } }));
        assert.deepStrictEqual(loader.stores().map((s) => s.name), ['automationStore', 'datatableStore', 'studioAppStore', 'datatableDbStore']);
        assert.deepStrictEqual(loader.stores()[0], { name: 'automationStore', file: './stores/automationStore' });
        assert.deepStrictEqual(loader.migrations(), ['routine-to-automation', 'apps-mig']);
        assert.deepStrictEqual(loader.nlTranslations(), ['add-nl-datatables', 'add-nl-apps']);
    });
});
