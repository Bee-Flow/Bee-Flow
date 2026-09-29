/**
 * generate_document — what the validator must catch before a run wastes a
 * render, and what it must NOT complain about while someone is still typing.
 *
 * The draft-stage rule is the subtle one. Every "you haven't filled this in
 * yet" code has to be listed in COMPLETENESS_CODES, or the autosave that fires
 * as the author clicks the node returns 400 and the canvas looks broken. It is
 * invisible in the happy path and infuriating in practice.
 *
 * Run: node --test automation/validate.generateDocument.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { validateDefinition } = require('./validate');

const base = (step) => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [{ id: 'gen1', type: 'generate_document', content: '{{trigger.output.text}}', format: 'pdf', ...step }],
    edges: [{ from: 'trg', to: 'gen1' }],
});

const codes = (def, opts) => validateDefinition(def, opts).errors.map(e => e.code);
const allCodes = (def, opts) => {
    const r = validateDefinition(def, opts);
    return [...r.errors, ...(r.warnings || [])].map(e => e.code);
};

test('a well-formed step validates clean', () => {
    assert.deepStrictEqual(codes(base()), []);
});

test('the step type is actually known — this is the registration canary', () => {
    // If VALID_STEP_TYPES was missed, EVERY other assertion here would pass
    // for the wrong reason: the type check short-circuits the per-type block.
    assert.ok(!allCodes(base()).includes('step.unknown_type'));
});

test('no content is an error — an empty document helps nobody', () => {
    assert.ok(codes(base({ content: '' })).includes('generate_document.content_missing'));
});

test('but missing content is only a WARNING while the author is still drafting', () => {
    // COMPLETENESS_CODES. Without this the canvas 400s on autosave mid-typing.
    const r = validateDefinition(base({ content: '' }), { stage: 'draft' });
    assert.ok(!r.errors.some(e => e.code === 'generate_document.content_missing'), 'not an error in a draft');
    assert.ok((r.warnings || []).some(e => e.code === 'generate_document.content_missing'), 'still reported');
});

test('an invented format is rejected, and the message says what is allowed', () => {
    const r = validateDefinition(base({ format: 'rtf' }));
    const issue = r.errors.find(e => e.code === 'generate_document.format');
    assert.ok(issue, 'rejected');
    assert.match(issue.hint, /pdf/);
    assert.match(issue.hint, /docx/);
});

test('both real formats are accepted', () => {
    for (const format of ['pdf', 'docx']) {
        assert.deepStrictEqual(codes(base({ format })), [], `${format} is fine`);
    }
});

test('contentFormat only takes markdown or html', () => {
    assert.ok(codes(base({ contentFormat: 'latex' })).includes('generate_document.content_format'));
    assert.deepStrictEqual(codes(base({ contentFormat: 'html' })), []);
});

test('the retention window is bounded at both ends', () => {
    // 0 days would make the step pointless; "forever" is not something to hand
    // out on an anonymously-reachable download.
    assert.ok(codes(base({ expiresInDays: 0 })).includes('generate_document.expiry_range'));
    assert.ok(codes(base({ expiresInDays: 365 })).includes('generate_document.expiry_range'));
    assert.deepStrictEqual(codes(base({ expiresInDays: 30 })), []);
});

test('a reference to a step that does not exist is reported', () => {
    // content/title/fileName are template strings; a typo there would otherwise
    // render an empty document with no complaint anywhere.
    const def = base({ content: '{{steps.nope.output.text}}' });
    assert.ok(allCodes(def).some(c => c.startsWith('ref.')), 'the bad ref surfaces');
});

test('it may have an error branch — rendering can genuinely fail', () => {
    const def = base();
    def.steps.push({ id: 'notif1', type: 'notification', channel: 'email', subject: 'x', body: 'y' });
    def.edges.push({ from: 'gen1', to: 'notif1', branch: 'on_error' });
    assert.ok(!allCodes(def).some(c => c.startsWith('edge.on_error')), 'no on_error complaint');
});
