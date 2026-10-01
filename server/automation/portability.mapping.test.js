/**
 * Export/import of a definition that uses the v2 mapping.
 *
 *   - The export says `requires: { mapping: 1 }` when the definition holds a
 *     pick, a compose, a step's repeat or a loop's `over`, and says nothing
 *     for a definition that uses none (legacy files stay as they were).
 *   - A file that needs a newer mapping version, or a capability this server
 *     does not know, is refused with a message, not imported half-working.
 *   - Re-keying on import renames the step ids inside picks, compose parts,
 *     repeat.over and a loop's over, as it does inside refs and templates.
 *
 * Run: cd server && node --test automation/portability.mapping.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildExport, sanitizeImport, rekeyDefinition, definitionUsesMapping, SUPPORTED_REQUIREMENTS } = require('./portability');

const S = (id, ...path) => ({ root: 'steps', id, path });
const pick = (from, take = 'one', as = 'native') => ({ kind: 'pick', v: 1, from, take, as });

function v2Definition() {
    return {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 'src', type: 'set', fields: { rows: { kind: 'literal', value: [] } } },
            {
                id: 'mail', type: 'notification', title: 'x',
                body: { kind: 'compose', v: 1, parts: ['Hoi ', { from: S('src', 'rows', 'naam'), take: 'all', as: 'text' }] },
                repeat: { over: S('src', 'rows') },
                inputs: { to: pick(S('src', 'rows', 'email'), 'each'), legacy: { kind: 'ref', path: 'steps.src.output.rows' } },
            },
            { id: 'lp', type: 'loop', itemVar: 'r', over: S('src', 'rows'), body: [{ id: 'in', type: 'set', fields: { a: pick({ root: 'loop', id: 'r', path: ['a'] }) } }] },
        ],
        edges: [{ from: 'trg', to: 'src' }, { from: 'src', to: 'mail' }, { from: 'mail', to: 'lp' }],
    };
}

test('an export of a v2 definition requires mapping 1; a legacy one requires nothing', () => {
    const { envelope } = buildExport({ title: 'v2', definition: v2Definition() });
    assert.deepStrictEqual(envelope.requires, { mapping: 1 });
    const legacy = buildExport({ title: 'old', definition: { trigger: { id: 't' }, steps: [{ id: 's', type: 'set', fields: { a: { kind: 'ref', path: 'trigger.output.a' } } }] } });
    assert.equal('requires' in legacy.envelope, false);
    assert.equal(definitionUsesMapping({ steps: [{ id: 'x', type: 'set', fields: { a: { kind: 'pick', from: S('y') } } }] }), false, 'a literal with kind pick is no v2 use');
    assert.equal(definitionUsesMapping({ steps: [{ id: 'x', type: 'set', repeat: { over: S('y') } }] }), true);
});

test('this server imports what it can read, and refuses a newer mapping with a message', () => {
    const { envelope } = buildExport({ title: 'v2', definition: v2Definition() });
    assert.deepStrictEqual(sanitizeImport(envelope).errors, []);
    const newer = sanitizeImport({ ...envelope, requires: { mapping: SUPPORTED_REQUIREMENTS.mapping + 1 } });
    assert.equal(newer.automation, null);
    assert.match(newer.errors[0], /needs mapping version 2, which is newer than this server supports \(1\)\. Update Bee Flow/);
    const unknown = sanitizeImport({ ...envelope, requires: { teleport: 1 } });
    assert.match(unknown.errors[0], /needs "teleport", which this server does not support/);
    assert.match(sanitizeImport({ ...envelope, requires: 'mapping' }).errors[0], /`requires` must be an object/);
    assert.match(sanitizeImport({ ...envelope, requires: { mapping: 'one' } }).errors[0], /must be a version number/);
});

test('re-keying renames the step ids inside picks, compose parts, repeat.over and a loop over', () => {
    const { definition, renameMap } = rekeyDefinition(v2Definition());
    const src = renameMap.root.src;
    assert.ok(src && src !== 'src');
    const mail = definition.steps[1];
    assert.equal(mail.inputs.to.from.id, src);
    assert.equal(mail.body.parts[1].from.id, src);
    assert.equal(mail.repeat.over.id, src);
    assert.equal(mail.inputs.legacy.path, `steps.${src}.output.rows`, 'legacy refs as before');
    const lp = definition.steps[2];
    assert.equal(lp.over.id, src);
    assert.equal(lp.body[0].fields.a.from.id, 'r', 'a loop item is named by its variable, not a step id');
});
