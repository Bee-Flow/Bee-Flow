const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./turnLoop');

test('sanitizeHistory keeps prose only, strips every machine note, and is UNCAPPED', () => {
    const history = [
        ...L.MACHINE_PREFIXES.map((p) => ({ role: 'user', content: `${p}\nnoise` })),
        { role: 'system', content: 'never' },
        { role: 'tool', content: 'never' },
        { role: 'user', content: ['array', 'content'] },
        ...Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}`, extra: true })),
    ];
    const out = L.sanitizeHistory(history);
    assert.equal(out.length, 50, 'no .slice(-20) — the compose site windows');
    assert.deepEqual(out[0], { role: 'user', content: 'm0' });
    assert.deepEqual(L.sanitizeHistory(null), []);
});

test('parseToolArgs is bound to this builder\'s parameterless tools', () => {
    assert.deepEqual(L.parseToolArgs('', 'app_finalize'), { args: {}, truncated: false });
    assert.deepEqual(L.parseToolArgs('{"na', 'app_finalize'), { args: {}, truncated: false });
    assert.deepEqual(L.parseToolArgs('{"na', 'app_add_components'), { args: {}, truncated: true });
});

test('truncationRetryMessages carries the validation-note prefix so history drops it', () => {
    const [, note] = L.truncationRetryMessages('half', []);
    assert.ok(note.content.startsWith(L.VALIDATION_NOTE_PREFIX));
    assert.deepEqual(L.sanitizeHistory([note]), []);
});

test('truncateJson never cuts mid-JSON', () => {
    const big = { a: 'x'.repeat(50_000) };
    const s = L.truncateJson(big, 1000);
    assert.doesNotThrow(() => JSON.parse(s));
    assert.equal(JSON.parse(s)._truncated, true);
    assert.equal(L.truncateJson({ ok: 1 }), '{"ok":1}');
});

test('the owner context note is a machine note: rendered by builderPrompt, stripped from history here', () => {
    const { renderOwnerContextNote, OWNER_CONTEXT_PREFIX } = require('../../../appStudio/builderPrompt');
    assert.equal(L.OWNER_CONTEXT_PREFIX, OWNER_CONTEXT_PREFIX, 'one prefix, owned by the renderer');
    assert.ok(L.MACHINE_PREFIXES.includes(OWNER_CONTEXT_PREFIX));
    const note = renderOwnerContextNote([{ id: 'auto_1', title: 'Intake', isActive: true, trigger: 'manual' }], []);
    assert.deepEqual(L.sanitizeHistory([{ role: 'user', content: note }, { role: 'user', content: 'Build it' }]), [{ role: 'user', content: 'Build it' }]);
});
