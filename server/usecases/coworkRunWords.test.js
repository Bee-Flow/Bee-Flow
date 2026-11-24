// @typecheck
/**
 * The tools of a run in a person's words (./coworkRunWords.mts): a label and an effect beside each tool, Cowork's own
 * tools marked internal, and a lookup that fails costs the words, never the history.
 *
 * Run: cd server && node --test usecases/coworkRunWords.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { withToolWords } = require('./coworkRunWords.mts');

/** @type {{ effectOfTool: (t: string) => 'reads' | 'writes' | 'sends', labelOfTool: (t: string) => string | null }} */
const lookups = {
    effectOfTool: (tool) => (tool === 'outlook_send' ? 'sends' : tool === 'outlook_create_draft' ? 'writes' : 'reads'),
    labelOfTool: (tool) => (tool === 'outlook_send' ? 'Outlook: send' : null),
};

const tool = (/** @type {string} */ name) => ({ name, app: 'outlook', ok: 1, failed: 0, refused: 0, reasons: [] });

test('each tool of a run carries what a person calls it and what it does', () => {
    const [run] = withToolWords([{ id: 'r1', activity: { tools: [tool('outlook_send'), tool('outlook_create_draft')], skills: [], toolCalls: 2 } }], lookups);
    assert.deepStrictEqual(run.activity.tools.map((t) => [t.name, t.label, t.effect, t.internal]), [
        ['outlook_send', 'Outlook: send', 'sends', false],
        ['outlook_create_draft', null, 'writes', false],
    ]);
    assert.strictEqual(run.activity.toolCalls, 2, 'the rest of the activity stays');
});

test('Cowork\'s own tools are marked internal: they are no step of the work', () => {
    const [run] = withToolWords([{ id: 'r1', activity: { tools: [tool('cowork_request_review'), tool('cowork_report_outcome')] } }], lookups);
    assert.deepStrictEqual(run.activity.tools.map((t) => [t.internal, t.label]), [[true, null], [true, null]]);
});

test('a run without activity is left as it is', () => {
    const runs = [{ id: 'r1', activity: null }, { id: 'r2' }];
    assert.deepStrictEqual(withToolWords(runs, lookups), runs);
});

test('a lookup that fails reads the tool as one that changes something, and the history still answers', () => {
    const broken = { effectOfTool: () => { throw new Error('registry down'); }, labelOfTool: () => null };
    const [run] = withToolWords([{ id: 'r1', activity: { tools: [tool('mystery')] } }], broken);
    assert.deepStrictEqual([run.activity.tools[0].effect, run.activity.tools[0].label], ['writes', null]);
});
