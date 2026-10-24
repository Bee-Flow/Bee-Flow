// @typecheck
/**
 * Test kit for suites that run the REAL cmsStore against an in-memory config
 * table. Only the store's Postgres edges are replaced: ./configStore becomes a
 * Map and ../db answers the store's `key LIKE` queries against that Map.
 *
 *   const { configState, clone } = installCmsStoreMocks();
 *   const cmsStore = require('./cmsStore');
 *
 * Install BEFORE the first require of cmsStore. Extra stubs (route siblings,
 * LLM plumbing) go in `extra`, keyed by the require string as written.
 */

const { installResolveStub } = require('../testUtils/stubRequire');
const { fallback } = require('../utils/bestEffort');

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

function likeToRegex(pattern) {
    // LIKE with ESCAPE '\': a backslash makes the next character literal; % is any run, _ any one character.
    let src = '';
    const chars = [...String(pattern)];
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (c === '\\' && i + 1 < chars.length) src += chars[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        else if (c === '%') src += '.*';
        else if (c === '_') src += '.';
        else src += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${src}$`);
}

/** The in-memory config table plus the configStore and db doubles over it. */
function createCmsConfigMocks() {
    const configState = { map: new Map() };
    /** @type {Map<string, Promise<unknown>>} */
    const locks = new Map();
    const mockConfigStore = {
        async getConfig(key) { return clone(configState.map.get(key)); },
        async getConfigFresh(key) { return clone(configState.map.get(key)); },
        async setConfig(key, value) { configState.map.set(key, clone(value)); },
        async deleteConfig(key) { configState.map.delete(key); },
        // One "transaction": writes are staged and land only if `work` resolves.
        // Groups on the same lock key run one after another, like the advisory lock.
        withConfigGroup(lockKey, work) {
            const turn = (locks.get(lockKey) || Promise.resolve()).then(() => runGroup(work));
            locks.set(lockKey, turn.catch((e) => fallback('stores/cmsStore.testkit:withConfigGroup', e)));
            return turn;
        },
        async mutateConfig(key, fn) {
            const cur = configState.map.has(key) ? clone(configState.map.get(key)) : undefined;
            const next = fn(cur);
            configState.map.set(key, clone(next));
            return next;
        },
    };
    async function runGroup(work) {
        const staged = new Map();
        const result = await work({
            async get(key) { return clone(staged.has(key) ? staged.get(key) : configState.map.get(key)); },
            async set(key, value) { staged.set(key, clone(value)); },
            async keysLike(pattern) {
                const re = likeToRegex(pattern);
                return [...new Set([...configState.map.keys(), ...staged.keys()])].filter((k) => re.test(k));
            },
        });
        for (const [k, v] of staged) configState.map.set(k, v);
        return result;
    }
    const mockDb = {
        async getAll(sql, params) {
            const keys = [...configState.map.keys()];
            const row = (k) => ({ key: k, value: JSON.stringify(configState.map.get(k)) });
            // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- test-kit fake matching our own fixed SQL strings
            if (/key = \$1 OR key LIKE \$2/.test(sql)) {
                // `key = $1 OR key LIKE $2 [OR key LIKE $3 ...]`
                const res = params.slice(1).map(likeToRegex);
                return keys.filter((k) => k === params[0] || res.some((re) => re.test(k))).map(row);
            }
            const re = likeToRegex(params[0]);
            return keys.filter((k) => re.test(k)).map(row);
        },
    };
    return { configState, mockConfigStore, mockDb };
}

/**
 * Stub cmsStore's Postgres edges (and any `extra` requests) and return the
 * mocks. Keys are the require strings AS WRITTEN in the module doing the
 * require: the store's aggregates live in stores/cms/, one level deeper than
 * the cmsStore.js facade, so both spellings of each edge are stubbed.
 * @param {(mocks: ReturnType<typeof createCmsConfigMocks>) => Record<string, any>} [extra]
 */
function installCmsStoreMocks(extra = () => ({})) {
    const mocks = createCmsConfigMocks();
    const { mockConfigStore, mockDb } = mocks;
    const restore = installResolveStub({
        './configStore': mockConfigStore,
        '../db': mockDb,
        '../configStore': mockConfigStore,
        '../../db': mockDb,
        ...extra(mocks),
    });
    return { ...mocks, clone, restore };
}

/**
 * A `recordDb` / routeHarness `answer` over an in-memory config table: the
 * handful of statements configStore issues (value read, upsert, delete, the
 * publishSite multi-key read and the key listings), answered from
 * `configState.map` (values stored as the JSON strings the pool would hold).
 * Anything else returns undefined, so the harness falls through.
 *
 *   const configState = { map: new Map() };
 *   recordDb(configTableAnswer(configState));
 */
function configTableAnswer(configState) {
    const keysLike = (p) => [...configState.map.keys()].filter((k) => likeToRegex(p).test(k)).map((key) => ({ key }));
    return (sql, params = []) => {
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- test-kit fake matching our own fixed SQL strings
        if (/^\s*SELECT value FROM config WHERE key = \$1/i.test(sql)) {
            return { rows: configState.map.has(params[0]) ? [{ value: configState.map.get(params[0]) }] : [] };
        }
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- test-kit fake matching our own fixed SQL strings
        if (/INSERT INTO config/i.test(sql)) { configState.map.set(params[0], params[1]); return { rows: [], rowCount: 1 }; }
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- test-kit fake matching our own fixed SQL strings
        if (/^\s*DELETE FROM config WHERE key = \$1/i.test(sql)) {
            const had = configState.map.delete(params[0]);
            return { rows: [], rowCount: had ? 1 : 0 };
        }
        // publishSite: the site doc, its pages and its locale overrides in one statement.
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- test-kit fake matching our own fixed SQL strings
        if (/SELECT key, value FROM config WHERE key = \$1 OR key LIKE \$2/i.test(sql)) {
            const patterns = params.slice(1).map(likeToRegex);
            return {
                rows: [...configState.map.keys()]
                    .filter((k) => k === params[0] || patterns.some((re) => re.test(k)))
                    .map((key) => ({ key, value: configState.map.get(key) })),
            };
        }
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- test-kit fake matching our own fixed SQL strings
        if (/SELECT key FROM config WHERE key = \$1 OR key LIKE \$2/i.test(sql)) {
            return { rows: [...(configState.map.has(params[0]) ? [{ key: params[0] }] : []), ...keysLike(params[1])] };
        }
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- test-kit fake matching our own fixed SQL strings
        if (/SELECT key FROM config WHERE key LIKE \$1/i.test(sql)) return { rows: keysLike(params[0]) };
        return undefined;
    };
}

module.exports = { clone, likeToRegex, createCmsConfigMocks, installCmsStoreMocks, configTableAnswer };
