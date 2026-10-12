/**
 * Tests for httpQuery: the structured query parameters of an http_request step.
 * Run: node --test core/automationRunner/httpQuery.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const {
    resolveQueryPairs, applyQueryToUrl, encodePairs, splitQueryFromUrl,
} = require('./httpQuery');

const state = (over = {}) => ({
    trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [], ...over,
});
const build = (query, runState = state(), url = 'https://x.example/api/tickets') =>
    applyQueryToUrl(url, resolveQueryPairs(query, runState));

const OWNER_JSON = '{"builder":[{"orderByDesc":"created_at"},{"with":["categories"]},{"paginate":{{trigger.output.size}}}]}';
const OWNER_EXPECTED = 'builder%5B0%5D%5BorderByDesc%5D=created_at&builder%5B1%5D%5Bwith%5D%5B0%5D=categories&builder%5B2%5D%5Bpaginate%5D=5';

test('the owner example (JSON mode, bound paginate) serialises like n8n', () => {
    const out = build({ mode: 'json', json: OWNER_JSON }, state({ trigger: { output: { size: 5 } } }));
    assert.strictEqual(out, `https://x.example/api/tickets?${OWNER_EXPECTED}`);
});

test('the owner example works in fields mode with bound values', () => {
    const q = { mode: 'fields', items: [
        { key: 'builder[0][orderByDesc]', value: 'created_at' },
        { key: 'builder[1][with][0]', value: 'categories' },
        { key: 'builder[2][paginate]', value: '{{trigger.output.size}}' },
    ] };
    assert.strictEqual(build(q, state({ trigger: { output: { size: 5 } } })), `https://x.example/api/tickets?${OWNER_EXPECTED}`);
});

test('every arrayFormat', () => {
    const json = '{"a":["x","y"]}';
    assert.strictEqual(build({ mode: 'json', json, arrayFormat: 'indices' }), 'https://x.example/api/tickets?a%5B0%5D=x&a%5B1%5D=y');
    assert.strictEqual(build({ mode: 'json', json }), 'https://x.example/api/tickets?a%5B0%5D=x&a%5B1%5D=y');
    assert.strictEqual(build({ mode: 'json', json, arrayFormat: 'brackets' }), 'https://x.example/api/tickets?a%5B%5D=x&a%5B%5D=y');
    assert.strictEqual(build({ mode: 'json', json, arrayFormat: 'repeat' }), 'https://x.example/api/tickets?a=x&a=y');
    assert.strictEqual(build({ mode: 'json', json, arrayFormat: 'comma' }), 'https://x.example/api/tickets?a=x%2Cy');
});

test('merges with an existing URL query and the step wins on the same key', () => {
    const out = build({ mode: 'fields', items: [{ key: 'page', value: '2' }] }, state(), 'https://x.example/a?page=1&keep=yes#top');
    assert.strictEqual(out, 'https://x.example/a?keep=yes&page=2#top');
});

test('an existing hand-encoded query is kept as written, never double encoded', () => {
    const out = build({ mode: 'fields', items: [{ key: 'z', value: '1' }] }, state(), 'https://x.example/a?builder%5B0%5D%5Bk%5D=v');
    assert.strictEqual(out, 'https://x.example/a?builder%5B0%5D%5Bk%5D=v&z=1');
    assert.ok(!out.includes('%25'));
});

test('a step key replaces an existing nested key of the same root', () => {
    const out = build({ mode: 'json', json: '{"builder":[{"paginate":9}]}' }, state(), 'https://x.example/a?builder%5B0%5D%5Bpaginate%5D=5');
    assert.strictEqual(out, 'https://x.example/a?builder%5B0%5D%5Bpaginate%5D=9');
});

test('typed bindings in JSON mode: numbers, booleans and quotes stay valid', () => {
    const rs = state({ trigger: { output: { n: 7, flag: true, text: 'say "hi" & go' } } });
    const out = build({ mode: 'json', json: '{"n":{{trigger.output.n}},"f":{{trigger.output.flag}},"t":"{{trigger.output.text}}"}' }, rs);
    assert.strictEqual(out, 'https://x.example/api/tickets?n=7&f=true&t=say%20%22hi%22%20%26%20go');
});

test('a fields value that is one placeholder keeps its list type', () => {
    const rs = state({ trigger: { output: { ids: [1, 2] } } });
    const out = build({ mode: 'fields', items: [{ key: 'id', value: '{{trigger.output.ids}}' }], arrayFormat: 'repeat' }, rs);
    assert.strictEqual(out, 'https://x.example/api/tickets?id=1&id=2');
});

test('keys accept bindings too', () => {
    const rs = state({ trigger: { output: { k: 'filter' } } });
    assert.strictEqual(build({ mode: 'fields', items: [{ key: '{{trigger.output.k}}', value: 'a' }] }, rs), 'https://x.example/api/tickets?filter=a');
});

test('empty, null and undefined values and blank keys are dropped', () => {
    const q = { mode: 'fields', items: [
        { key: 'a', value: '' }, { key: '', value: 'x' }, { key: 'b', value: '{{trigger.output.missing}}' }, { key: 'c', value: '0' },
    ] };
    assert.strictEqual(build(q), 'https://x.example/api/tickets?c=0');
    assert.strictEqual(build({ mode: 'json', json: '{"a":null,"b":"","c":[],"d":{},"e":false}' }), 'https://x.example/api/tickets?e=false');
});

test('no pairs leaves the URL untouched', () => {
    assert.strictEqual(build({ mode: 'fields', items: [] }, state(), 'https://x.example/a?k=1'), 'https://x.example/a?k=1');
});

test('error messages name the reason and never quote the content', () => {
    assert.throws(() => resolveQueryPairs({ mode: 'json', json: '{"secret": oops' }, state()), (e) => {
        assert.strictEqual(e.stepErrorCode, 'http_query_invalid');
        assert.match(e.userReason, /JSON is not valid/);
        assert.ok(!e.message.includes('oops'));
        return true;
    });
    assert.throws(() => resolveQueryPairs({ mode: 'json', json: '[1,2]' }, state()), /must be an object/);
    assert.throws(() => resolveQueryPairs({ mode: 'xml' }, state()), /mode "xml" is unknown/);
    assert.throws(() => resolveQueryPairs('page=1', state()), /not an object/);
    assert.throws(() => resolveQueryPairs({ mode: 'fields', items: [5] }, state()), /row 1/);
});

test('splitQueryFromUrl turns bracket keys back into nested JSON and round-trips', () => {
    const url = `https://x.example/api/tickets?${OWNER_EXPECTED}&page=1`;
    const split = splitQueryFromUrl(url);
    assert.strictEqual(split.url, 'https://x.example/api/tickets');
    assert.deepStrictEqual(JSON.parse(split.query.json), {
        builder: [{ orderByDesc: 'created_at' }, { with: ['categories'] }, { paginate: '5' }], page: '1',
    });
    assert.strictEqual(applyQueryToUrl(split.url, resolveQueryPairs(split.query, state())),
        `https://x.example/api/tickets?${OWNER_EXPECTED}&page=1`);
});

test('splitQueryFromUrl: no query returns null, repeated and bracket arrays', () => {
    assert.strictEqual(splitQueryFromUrl('https://x.example/a'), null);
    assert.strictEqual(splitQueryFromUrl('https://x.example/a?'), null);
    const s = splitQueryFromUrl('https://x.example/a?t[]=1&t[]=2&r=1&r=2');
    assert.deepStrictEqual(JSON.parse(s.query.json), { t: ['1', '2'], r: ['1', '2'] });
    assert.strictEqual(s.query.arrayFormat, 'brackets');
});

test('encodePairs encodes keys and values', () => {
    assert.strictEqual(encodePairs([['a b', 'c&d']]), 'a%20b=c%26d');
});
