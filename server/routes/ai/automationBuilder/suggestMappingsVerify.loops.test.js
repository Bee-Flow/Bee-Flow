/**
 * suggestMappingsVerify.js: a step that runs once per element reads the
 * CURRENT element, also when lists sit inside lists.
 *
 * The editor offers a step that runs per attachment of every mail its outer
 * item too: sources [steps.s1.output, loop.mail, loop.att], outer loop first
 * (upstream/groups.js lists forEach parents before the item). A model that
 * answers `…value[0].attachments[0].name` or `loop.mail.attachments[0].name`
 * means "the attachment", and the runtime would read attachment 0 of mail 0
 * on every iteration. The verifier rewrites such a path to the innermost loop
 * that runs over that list, whatever order the sources came in, and also
 * when the path already starts at an outer loop.
 *
 * The editor's loop sample is not always element [0]: for real data it is
 * the union of the first rows (upstream mergeElements: the first value that
 * says something per key, nested lists concatenated). The repair recognises
 * that too, and leaves a list alone whose rows disagree with the sample.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/suggestMappingsVerify.loops.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { normaliseSuggestRequest, verifySuggestions, SuggestMappingsBody } = require('./suggestMappings');

const PARAMS = [{ key: 'file', type: 'string' }, { key: 'subject', type: 'string' }, { key: 'other', type: 'string' }];
const verify = (bindings, sources) => verifySuggestions(bindings, normaliseSuggestRequest(SuggestMappingsBody.parse({ params: PARAMS, sources })));
const pathOf = (out, key) => {
    const s = out.suggestions.find((x) => x.key === key);
    return s ? s.binding.path : `rejected: ${out.rejected.find((r) => r.key === key)?.reason}`;
};

// One mail with two attachments, as the Gmail catalog sample has it: the
// outer loop's sample IS that mail, the inner loop's the first attachment.
const MAIL = { id: 'm1', subject: 'Invoices', attachments: [{ id: 'a1', name: 'a1.pdf' }, { id: 'a2', name: 'a2.pdf' }] };
const STEP = { root: 'steps.s1.output', label: 'Search mail', real: true, sample: { value: [MAIL] } };
const OUTER = { root: 'loop.mail', label: 'Outer item (mail)', real: true, sample: MAIL };
const INNER = { root: 'loop.att', label: 'Current item (att)', real: true, sample: { id: 'a1', name: 'a1.pdf' } };

test('a per-attachment step reads the current attachment, not attachment 0 of the current mail', () => {
    const out = verify([{ key: 'file', kind: 'ref', path: 'steps.s1.output.value[0].attachments[0].name' }], [STEP, OUTER, INNER]);
    assert.strictEqual(pathOf(out, 'file'), 'loop.att.name');
});

test('a path that starts at the outer loop is repaired to the inner one as well', () => {
    const out = verify([
        { key: 'file', kind: 'ref', path: 'loop.mail.attachments[0].name' },
        { key: 'other', kind: 'ref', path: 'attachments[0].name' },
    ], [STEP, OUTER, INNER]);
    assert.strictEqual(pathOf(out, 'file'), 'loop.att.name');
    // Relative: only loop.mail holds it, and from there it is the current attachment.
    assert.strictEqual(pathOf(out, 'other'), 'loop.att.name');
});

test('the order the sources come in does not matter', () => {
    for (const sources of [[STEP, OUTER, INNER], [STEP, INNER, OUTER], [INNER, OUTER, STEP]]) {
        const out = verify([
            { key: 'file', kind: 'ref', path: 'steps.s1.output.value[0].attachments[0].name' },
            { key: 'subject', kind: 'ref', path: 'steps.s1.output.value[0].subject' },
        ], sources);
        assert.strictEqual(pathOf(out, 'file'), 'loop.att.name', sources.map((s) => s.root).join(', '));
        // The mail's own fields come from the outer item.
        assert.strictEqual(pathOf(out, 'subject'), 'loop.mail.subject');
    }
});

// Two real mails, keys differing per mail: the editor's outer sample is their
// union (cc only on the second, attachments concatenated), not mail [0].
const MAILS = [
    { id: 'm1', subject: 'Invoices', attachments: [{ id: 'a1', name: 'a1.pdf' }, { id: 'a2', name: 'a2.pdf' }] },
    { id: 'm2', subject: 'Contract', cc: ['legal'], attachments: [{ id: 'b1', name: 'b1.pdf' }] },
];
const MERGED_MAIL = { id: 'm1', subject: 'Invoices', attachments: [...MAILS[0].attachments, ...MAILS[1].attachments], cc: ['legal'] };
const STEP2 = { ...STEP, sample: { value: MAILS } };
const OUTER2 = { ...OUTER, sample: MERGED_MAIL };

test('a merged (key-union) loop sample is still recognised as the list it runs over', () => {
    const perMail = verify([{ key: 'subject', kind: 'ref', path: 'steps.s1.output.value[0].subject' }], [STEP2, OUTER2]);
    assert.strictEqual(pathOf(perMail, 'subject'), 'loop.mail.subject');
    // A key only the second mail has, offered from that mail, is the current mail's too.
    const second = verify([{ key: 'other', kind: 'ref', path: 'steps.s1.output.value[1].cc' }], [STEP2, OUTER2]);
    assert.strictEqual(second.suggestions[0]?.binding.value, 'join(loop.mail.cc, ", ")');

    const nested = verify([
        { key: 'file', kind: 'ref', path: 'steps.s1.output.value[0].attachments[0].name' },
        { key: 'other', kind: 'ref', path: 'loop.mail.attachments[2].name' },
    ], [STEP2, OUTER2, INNER]);
    assert.strictEqual(pathOf(nested, 'file'), 'loop.att.name');
    assert.strictEqual(pathOf(nested, 'other'), 'loop.att.name');
});

test('a list whose rows disagree with the loop sample, or a read of every element, is left as written', () => {
    const files = { root: 'steps.s2.output', label: 'Other files', sample: { files: [{ id: 'f1', name: 'other.pdf' }] } };
    const out = verify([
        { key: 'file', kind: 'ref', path: 'steps.s2.output.files[0].name' },
        { key: 'other', kind: 'expr', value: 'join(steps.s1.output.value[*].attachments[0].name, ", ")' },
    ], [STEP, files, OUTER, INNER]);
    assert.strictEqual(pathOf(out, 'file'), 'steps.s2.output.files[0].name');
    assert.strictEqual(out.suggestions.find((s) => s.key === 'other')?.binding.value, 'join(steps.s1.output.value[*].attachments[0].name, ", ")');
});
