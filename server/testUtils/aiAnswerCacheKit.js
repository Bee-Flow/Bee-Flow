// @typecheck strict
'use strict';

/**
 * What the ai_step answer-cache suites share: the config and durable-cache
 * stores as in-memory doubles, the opted-in org policy, and a request/args
 * builder for `planAiReuse`.
 *
 *   const kit = installAiAnswerCacheKit();            // BEFORE requiring ./aiStepCache
 *   after(kit.restore);
 *   const { planAiReuse } = require('./aiStepCache');
 *   beforeEach(kit.reset);
 *   kit.failStore = true;                             // the durable store throws
 *
 * `cfg`, `durableRows`, `durableGets` and `durablePuts` are the live
 * collections the doubles read and write.
 */

const crypto = require('crypto');
const { installResolveStub } = require('./stubRequire');

const ORG = 'org-a';
const POLICY_KEY = `org_integration_cache_${ORG}`;
const flush = () => new Promise(r => setImmediate(r));

const REQUEST = {
    route: 'structured',
    messages: [{ role: 'system', content: 'Sort the item.' }, { role: 'user', content: 'item <PERSON_1> arrived' }],
    schema: { type: 'object', properties: { label: { type: 'string' } } },
    temperature: 0.2,
    maxOutputTokens: 1024,
    reasoningEffort: /** @type {string | null} */ (null),
};
const ANSWER = { content: /** @type {string | null} */ (null), structured: { label: 'alpha' } };

function installAiAnswerCacheKit() {
    /** @type {Record<string, any>} */
    const cfg = {};
    /** @type {Map<string, any>} */
    const durableRows = new Map();
    /** @type {any[]} */
    const durableGets = [];
    /** @type {any[]} */
    const durablePuts = [];
    const kit = { cfg, durableRows, durableGets, durablePuts, failStore: false, ORG, POLICY_KEY, flush, REQUEST, ANSWER };

    const restore = installResolveStub({
        '../../stores/configStore': {
            async getConfig(/** @type {string} */ key) { return cfg[key] !== undefined ? cfg[key] : null; },
            async setConfig(/** @type {string} */ key, /** @type {any} */ value) { cfg[key] = value; return true; },
        },
        '../../stores/integrationCacheStore': {
            cacheKey: (/** @type {any} */ identity) => crypto.createHash('sha256').update(String(identity || '')).digest('hex'),
            async get(/** @type {string} */ key, /** @type {string} */ organizationId, opts = {}) {
                durableGets.push({ key, organizationId, ...opts });
                if (kit.failStore) throw new Error('database unavailable');
                const row = durableRows.get(key);
                return (row && row.organizationId === organizationId) ? { value: row.value } : null;
            },
            async put(/** @type {any} */ record) {
                durablePuts.push(record);
                if (kit.failStore) throw new Error('database unavailable');
                durableRows.set(record.key, record);
                return true;
            },
        },
    });

    const { createToolMemo } = require('../core/automationRunner/toolMemo');
    const policy = require('../core/automationRunner/integrationCachePolicy');

    const makeCtx = (over = {}) => ({ userId: 'u1', orgId: ORG, _toolMemo: createToolMemo(), ...over });
    const makeArgs = (over = {}) => ({
        step: { id: 's1', type: 'ai_step', askOnce: { acrossRuns: true } },
        ctx: makeCtx(),
        mode: 'live',
        policy: { action: 'tokenize', privacyScope: 'external' },
        modelId: 'model-a',
        providerKey: 'llm:abc',
        toolsOffered: false,
        request: REQUEST,
        ...over,
    });

    function reset() {
        for (const k of Object.keys(cfg)) delete cfg[k];
        cfg[POLICY_KEY] = { enabled: true, ttlSeconds: 600, scopes: { integration: true, http: false, ai: true } };
        policy.invalidateCachePolicy();
        durableRows.clear();
        durableGets.length = 0;
        durablePuts.length = 0;
        kit.failStore = false;
        delete process.env.AUTOMATION_ASK_ONCE_DISABLED;
        delete process.env.INTEGRATION_CACHE_DISABLED;
    }

    return Object.assign(kit, { restore, makeCtx, makeArgs, policy, reset });
}

module.exports = { installAiAnswerCacheKit };
