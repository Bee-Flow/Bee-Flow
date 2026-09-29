/**
 * Title sanitisation contract.
 *
 * A model tuned for structured output (lfm2-1.2b-extract, set as the title
 * model on the demo box) answered every title request with a JSON record,
 * cut off by the 64-token cap. The old sanitiser only stripped the quotes, so
 * the sidebar showed `{ title: Bee Flow: AI Workflow …` for every chat
 * (2026-09-18). The samples below are the real outputs of that model and of
 * the models it was compared against.
 *
 * DB-free: same store cut as llmClient.forcedTool.test.js.
 */

const { test, after } = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

const restoreStores = installResolveStub({
    '../../stores/configStore': {
        getConfig: async () => null,
        setConfig: async () => {},
        getSecret: async () => null,
        setSecret: async () => {},
    },
});
after(() => restoreStores());

const llmClient = require('./llmClient');
const t = (raw) => llmClient._sanitiseTitle(raw);

test('a plain title passes through, quotes stripped and whitespace collapsed', () => {
    assert.equal(t('Bee Flow Presentation'), 'Bee Flow Presentation');
    assert.equal(t('"Bee Flow   Presentation"\n'), 'Bee Flow Presentation');
    assert.equal(t('Bee Flow: AI Workflow Automation'), 'Bee Flow: AI Workflow Automation');
});

test('a truncated JSON record (the lfm2-extract output) yields its title field', () => {
    const raw = '{\n  "title": "Bee Flow: AI Workflow Automation",\n  "content_excerpt": "Around 8 slides, about airplane mode / offline AI.",\n  "target_audience": "Engineers",\n  "version": "1.0",\n  "date_created": "202';
    assert.equal(t(raw), 'Bee Flow: AI Workflow Automation');
});

test('a complete JSON record yields its title-like field, whichever key the model chose', () => {
    assert.equal(t('{"title": "Visual test deck", "excerpt": "..."}'), 'Visual test deck');
    assert.equal(t('{"excerpt": "Bee Flow · engineering", "name": "Engineering deck"}'), 'Engineering deck');
    assert.equal(t('[{"topic": "Airplane Mode"}]'), 'Airplane Mode');
});

test('a JSON record without a title-like field is not a title', () => {
    assert.equal(t('{"excerpt": "Bee Flow · engineering onboarding"}'), 'New Chat');
    assert.equal(t('{ "content_excerpt": "Around 8 slides'), 'New Chat');
    assert.equal(t('{"title": ""}'), 'New Chat');
});

test('fenced JSON is unwrapped; any other fenced block is treated as hallucinated code', () => {
    assert.equal(t('```json\n{"title": "Invoice batch"}\n```'), 'Invoice batch');
    assert.equal(t('```js\nconsole.log("hi")\n```'), 'New Chat');
    assert.equal(t('```\nfunction title() {}'), 'New Chat');
});

test('tags are stripped, empty output falls back, long output is capped at 80', () => {
    assert.equal(t('<b>Bee Flow</b> deck'), 'Bee Flow deck');
    assert.equal(t(''), 'New Chat');
    assert.equal(t(null), 'New Chat');
    assert.equal(t('x'.repeat(200)).length, 80);
});
