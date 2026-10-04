/**
 * Validator rules for `askOnce` — "ask this app only once per run", and the
 * narrower "…and keep the answer for later runs".
 *
 * The two rules that matter here say opposite-shaped things, and getting the
 * SEVERITY right is the point:
 *
 *   a WRITE with askOnce is an ERROR. There is no reading of it that is safe —
 *   reusing the answer to "send this e-mail" means the second send silently
 *   does not happen.
 *
 *   a read the runtime refuses to memoise is a WARNING. The definition is
 *   valid; it simply asks every time. Nothing breaks, but a step that quietly
 *   ignores its own setting looks like a slow step, and nobody would ever find
 *   out why.
 *
 *   acrossRuns is also a WARNING, for the same reason in a different place:
 *   the author cannot see their organisation's setting from here, so a step
 *   that stores nothing looks identical to one that does.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { validateDefinition } = require('./validate');

const TRIGGER = { id: 'trg', kind: 'manual' };

function def(step) {
    return {
        trigger: TRIGGER,
        steps: [{ id: 's1', type: 'integration_action', ...step }],
        edges: [{ from: 'trg', to: 's1' }],
    };
}
function codesOf(definition) {
    const res = validateDefinition(definition);
    return {
        errors: (res.errors || []).map(e => e.code),
        warnings: (res.warnings || []).map(e => e.code),
    };
}

test('an ordinary read may be asked once per run, with nothing to say about it', () => {
    const { errors, warnings } = codesOf(def({ tool: 'gmail_search', inputs: { q: 'x' }, askOnce: true }));
    assert.ok(!errors.some(c => c.startsWith('integration_action.ask_once')));
    assert.ok(!warnings.some(c => c.startsWith('integration_action.ask_once')));
});

test('a WRITE asked once per run is an error', () => {
    const { errors } = codesOf(def({ tool: 'gmail_compose', inputs: {}, askOnce: true }));
    assert.ok(errors.includes('integration_action.ask_once_on_write'),
        'reusing the answer to a send means the second send silently does not happen');
});

test('a read the runtime will not memoise is a WARNING, not an error', () => {
    const { errors, warnings } = codesOf(def({ tool: 'nextcloud_status_get', inputs: {}, askOnce: true }));
    assert.ok(!errors.some(c => c.startsWith('integration_action.ask_once')),
        'the definition is valid — it simply asks every time');
    assert.ok(warnings.includes('integration_action.ask_once_not_supported'));
});

test('every nextcloud read warns, because the dispatch is where permission is checked', () => {
    const { warnings } = codesOf(def({ tool: 'nextcloud_list_files', inputs: {}, askOnce: true }));
    assert.ok(warnings.includes('integration_action.ask_once_not_supported'));
});

test('absent askOnce says nothing at all', () => {
    const { errors, warnings } = codesOf(def({ tool: 'gmail_compose', inputs: {} }));
    assert.ok(!errors.some(c => c.startsWith('integration_action.ask_once')));
    assert.ok(!warnings.some(c => c.startsWith('integration_action.ask_once')));
});

test('askOnce: false is off, and is not a write error even on a write', () => {
    const { errors } = codesOf(def({ tool: 'gmail_compose', inputs: {}, askOnce: false }));
    assert.ok(!errors.includes('integration_action.ask_once_on_write'));
});

test('a ttl outside the supported window is an error', () => {
    for (const ttlSeconds of [0, -5, 901, 100000]) {
        const { errors } = codesOf(def({ tool: 'gmail_search', inputs: {}, askOnce: { ttlSeconds } }));
        assert.ok(errors.includes('integration_action.ask_once_ttl_range'), `ttl ${ttlSeconds} should be refused`);
    }
});

test('a ttl inside it is fine, and an absent one is the default', () => {
    for (const askOnce of [{ ttlSeconds: 1 }, { ttlSeconds: 900 }, { ttlSeconds: 60 }, {}]) {
        const { errors } = codesOf(def({ tool: 'gmail_search', inputs: {}, askOnce }));
        assert.ok(!errors.includes('integration_action.ask_once_ttl_range'));
    }
});

test('acrossRuns warns that an administrator has the final say', () => {
    const { errors, warnings } = codesOf(def({ tool: 'gmail_search', inputs: {}, askOnce: { acrossRuns: true } }));
    assert.deepStrictEqual(errors.filter(c => c.startsWith('integration_action.ask_once')), []);
    assert.ok(warnings.includes('integration_action.ask_once_across_runs_org_gated'),
        'a step that stores nothing looks identical to one that does');
});

test('acrossRuns false says nothing', () => {
    const { warnings } = codesOf(def({ tool: 'gmail_search', inputs: {}, askOnce: { acrossRuns: false } }));
    assert.ok(!warnings.includes('integration_action.ask_once_across_runs_org_gated'));
});

test('a non-boolean acrossRuns is an error rather than a truthy guess', () => {
    for (const acrossRuns of ['true', 1, 'yes', {}]) {
        const { errors } = codesOf(def({ tool: 'gmail_search', inputs: {}, askOnce: { acrossRuns } }));
        assert.ok(errors.includes('integration_action.ask_once_across_runs_type'),
            `${JSON.stringify(acrossRuns)} must not be read as a yes`);
    }
});

test('acrossRuns on a WRITE still leads with the write error', () => {
    const { errors } = codesOf(def({ tool: 'gmail_compose', inputs: {}, askOnce: { acrossRuns: true } }));
    assert.ok(errors.includes('integration_action.ask_once_on_write'));
});

// ── the setting belongs to TWO step types ────────────────────────────────────
//
// execIntegrationAction and execHttpRequest (via httpCache.js) are the only
// readers of `askOnce`. The rules above are therefore those steps' rules, not
// the platform's: run them for every type and an askOnce on an ai_step
// validates clean, earns the friendly "your administrator decides" warning, and
// does absolutely nothing — the silent no-op the whole warning exists to
// prevent. http_request used to be in this list and is now a first-class
// reader; its own rules are the block below.

const OTHER_TYPES = [
    { type: 'ai_step', prompt: 'Summarise it' },
    { type: 'code', code: 'return {}' },
    { type: 'notification', title: 'Hi', body: 'There' },
];

test('askOnce on a step the runner never reads it on is a warning', () => {
    for (const step of OTHER_TYPES) {
        const { warnings } = codesOf(def({ ...step, askOnce: true }));
        assert.ok(warnings.includes(`${step.type}.ask_once_unsupported`),
            `${step.type} silently ignores askOnce, so the author has to be told`);
    }
});

test('the integration_action rules do NOT leak onto other types', () => {
    for (const step of OTHER_TYPES) {
        const { errors, warnings } = codesOf(def({ ...step, askOnce: { acrossRuns: true, ttlSeconds: 99999 } }));
        assert.deepStrictEqual(errors.filter(c => c.startsWith('integration_action.')), [],
            `${step.type}: an out-of-range ttl on a field nobody reads is not an error about a look-up`);
        assert.ok(!warnings.includes('integration_action.ask_once_across_runs_org_gated'),
            `${step.type}: "your administrator decides" would promise storage that never happens`);
    }
});

test('an integration_action never gets the "does nothing here" warning', () => {
    const { warnings } = codesOf(def({ tool: 'gmail_search', inputs: {}, askOnce: true }));
    assert.ok(!warnings.some(c => c.endsWith('.ask_once_unsupported')));
});

test('a null askOnce is off, not a truthy guess', () => {
    // The old guard was `!== undefined && !== false`, so a null walked into
    // the write check and errored a step whose setting does nothing.
    const { errors, warnings } = codesOf(def({ tool: 'gmail_compose', inputs: {}, askOnce: null }));
    assert.ok(!errors.some(c => c.startsWith('integration_action.ask_once')));
    assert.ok(!warnings.some(c => c.includes('ask_once')));
});

// ── http_request ───────────────────────────────────────────
//
// Same rules, its own codes, and the write test is a METHOD test rather than a
// tool test: HTTP_REQUEST_WRITE_METHODS is this step's isSideEffect.

const HTTP = { type: 'http_request', url: 'https://api.example.com/rates', method: 'GET' };

test('a GET may be asked once per run, with nothing to say about it', () => {
    const { errors, warnings } = codesOf(def({ ...HTTP, askOnce: true }));
    assert.deepStrictEqual(errors.filter(c => c.startsWith('http_request.ask_once')), []);
    assert.deepStrictEqual(warnings.filter(c => c.startsWith('http_request.ask_once')), []);
});

test('a HEAD may too', () => {
    const { errors } = codesOf(def({ ...HTTP, method: 'HEAD', askOnce: true }));
    assert.deepStrictEqual(errors.filter(c => c.startsWith('http_request.ask_once')), []);
});

test('askOnce on a WRITE METHOD is a WARNING — the definition stays valid', () => {
    // The owner's call, 2026-09-02. It was an ERROR, which made the whole
    // definition invalid and put a red "Invalid definition" bar under the step —
    // blocking exactly the POST-as-look-up this control was opened up for
    // (DataForSEO, GraphQL, Elasticsearch all query by POST).
    //
    // A warning still says it, because a cache hit on a POST that CREATES
    // something means that creation silently never happens. Only the author
    // knows which kind of POST theirs is.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const { errors, warnings } = codesOf(def({ ...HTTP, method, body: '{}', askOnce: true }));
        assert.deepStrictEqual(errors.filter(c => c === 'http_request.ask_once_on_write'), [],
            `${method}: a caution must not make the automation unsaveable`);
        assert.ok(warnings.includes('http_request.ask_once_on_write'),
            `${method}: the cost of a hit must still be stated somewhere`);
    }
});

test('a lower-case method is still a write, and still warns', () => {
    const { errors, warnings } = codesOf(def({ ...HTTP, method: 'post', body: '{}', askOnce: true }));
    assert.deepStrictEqual(errors.filter(c => c === 'http_request.ask_once_on_write'), []);
    assert.ok(warnings.includes('http_request.ask_once_on_write'));
});

test('a GET carries no write caution at all', () => {
    const { errors, warnings } = codesOf(def({ ...HTTP, askOnce: true }));
    assert.ok(!warnings.includes('http_request.ask_once_on_write'));
    assert.deepStrictEqual(errors.filter(c => c.startsWith('http_request.ask_once')), []);
});

test('askOnce with the SSRF guard off warns that nothing will be reused', () => {
    const { errors, warnings } = codesOf(def({ ...HTTP, blockPrivateTargets: false, askOnce: true }));
    assert.deepStrictEqual(errors.filter(c => c.startsWith('http_request.ask_once')), [],
        'the definition is valid — the runtime simply refuses to reuse anything');
    assert.ok(warnings.includes('http_request.ask_once_private_targets'),
        'a step that silently never reuses anything looks exactly like a slow step');
});

test('the guard-off warning is not raised when the guard is on', () => {
    const { warnings } = codesOf(def({ ...HTTP, askOnce: true }));
    assert.ok(!warnings.includes('http_request.ask_once_private_targets'));
});

test('a ttl outside the supported window is an error here too', () => {
    for (const ttlSeconds of [0, -5, 901]) {
        const { errors } = codesOf(def({ ...HTTP, askOnce: { ttlSeconds } }));
        assert.ok(errors.includes('http_request.ask_once_ttl_range'), `ttl ${ttlSeconds} should be refused`);
    }
});

test('http acrossRuns warns that an administrator has the final say', () => {
    const { errors, warnings } = codesOf(def({ ...HTTP, askOnce: { acrossRuns: true } }));
    assert.deepStrictEqual(errors.filter(c => c.startsWith('http_request.ask_once')), []);
    assert.ok(warnings.includes('http_request.ask_once_across_runs_org_gated'));
});

test('a non-boolean http acrossRuns is an error rather than a truthy guess', () => {
    for (const acrossRuns of ['true', 1, 'yes']) {
        const { errors } = codesOf(def({ ...HTTP, askOnce: { acrossRuns } }));
        assert.ok(errors.includes('http_request.ask_once_across_runs_type'));
    }
});

test('an http_request never gets the "does nothing here" warning any more', () => {
    const { warnings } = codesOf(def({ ...HTTP, askOnce: true }));
    assert.ok(!warnings.some(c => c.endsWith('.ask_once_unsupported')));
});

test('the integration_action codes never appear on an http_request', () => {
    const { errors, warnings } = codesOf(def({ ...HTTP, method: 'POST', body: '{}', askOnce: { acrossRuns: true, ttlSeconds: 99999 } }));
    assert.deepStrictEqual(errors.filter(c => c.startsWith('integration_action.')), []);
    assert.deepStrictEqual(warnings.filter(c => c.startsWith('integration_action.')), []);
});

test('forEach on an http_request is accepted — the runner has always honoured it', () => {
    const { errors } = codesOf(def({
        ...HTTP,
        forEach: { overRef: 'trigger.output.rows', itemVar: 'row' },
    }));
    assert.ok(!errors.includes('foreach.type_unsupported'),
        'builder_update_step accepted this field while builder_finalize hard-rejected it');
});

// ── cacheInto — the VISIBLE half of the same idea ───────────────────────────
//
// An INDEPENDENT tick, and the rules below are what makes that safe. The
// refusals are askOnce's refusals because they are the same call; the wording
// differs because the two controls explain different things, and two disabled
// reasons that read identically leave the author unable to tell which one is
// being talked about.

const CACHE = { datatableId: 'tbl_answers', maxAgeDays: 30 };

test('cacheInto on a GET is valid, and says out loud that the rows are readable', () => {
    const { errors, warnings } = codesOf(def({ ...HTTP, cacheInto: CACHE }));
    assert.deepStrictEqual(errors.filter(c => c.startsWith('http_request.cache_into')), []);
    assert.ok(warnings.includes('http_request.cache_into_plaintext'),
        'the difference from the encrypted tier is not discoverable from the behaviour');
});

test('cacheInto on a WRITE method is a WARNING, exactly like askOnce', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const { errors, warnings } = codesOf(def({ ...HTTP, method, body: '{}', cacheInto: CACHE }));
        assert.deepStrictEqual(errors.filter(c => c === 'http_request.cache_into_on_write'), [], method);
        assert.ok(warnings.includes('http_request.cache_into_on_write'), method);
    }
});

test('cacheInto with no table is an error — a window with nothing to keep does nothing', () => {
    const { errors } = codesOf(def({ ...HTTP, cacheInto: { maxAgeDays: 30 } }));
    assert.ok(errors.includes('http_request.cache_into_table_missing'));
});

test('cacheInto while private targets are allowed is a WARNING — the definition is valid, it just never keeps anything', () => {
    const { errors, warnings } = codesOf(def({ ...HTTP, blockPrivateTargets: false, cacheInto: CACHE }));
    assert.deepStrictEqual(errors.filter(c => c.startsWith('http_request.cache_into')), []);
    assert.ok(warnings.includes('http_request.cache_into_private_targets'));
});

test('a maxAgeDays outside 1..3650 is an error rather than a silent clamp', () => {
    // A numeric STRING is accepted, exactly as askOnce.ttlSeconds is: both go
    // through Number(), and disagreeing about that between two sibling fields
    // would be its own trap.
    for (const maxAgeDays of [0, -1, 3651, 1.5, 'thirty']) {
        const { errors } = codesOf(def({ ...HTTP, cacheInto: { ...CACHE, maxAgeDays } }));
        assert.ok(errors.includes('http_request.cache_into_max_age_range'), String(maxAgeDays));
    }
    const ok = codesOf(def({ ...HTTP, cacheInto: { datatableId: 'tbl_x' } }));
    assert.ok(!ok.errors.includes('http_request.cache_into_max_age_range'),
        'leaving it out is the thirty-day default, not an error');
});

test('a malformed cacheInto is refused by shape rather than half-read', () => {
    for (const cacheInto of ['tbl_x', 42, ['tbl_x']]) {
        const { errors } = codesOf(def({ ...HTTP, cacheInto }));
        assert.ok(errors.includes('http_request.cache_into_shape'), JSON.stringify(cacheInto));
    }
});

test('cacheInto on any OTHER step type warns that it does nothing there', () => {
    // execHttpRequest is the only reader, so on an ai_step this is a field the
    // runtime never consults — the silent no-op the whole block exists to stop.
    const { warnings } = codesOf(def({ type: 'ai_step', prompt: 'hi', cacheInto: CACHE }));
    assert.ok(warnings.includes('ai_step.cache_into_unsupported'), warnings.join(','));
});

test('cacheInto alone never earns the askOnce "does nothing here" warning', () => {
    const { warnings } = codesOf(def({ ...HTTP, cacheInto: CACHE }));
    assert.ok(!warnings.some(c => c.endsWith('.ask_once_unsupported')),
        'the two ticks are independent — one on and the other off is an ordinary configuration');
});

test('both ticks together validate clean', () => {
    const { errors } = codesOf(def({ ...HTTP, askOnce: true, cacheInto: CACHE }));
    assert.deepStrictEqual(errors.filter(c => c.startsWith('http_request.')), []);
});
