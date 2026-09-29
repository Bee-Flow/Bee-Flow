/**
 * Pure summary-template helpers — no DB, no LLM.
 *
 * Run: cd server && node --test utils/summaryTemplates.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    BUILTIN_TEMPLATES,
    builtinPrompt,
    buildSummarySystemPrompt,
    pickDefaultTemplate,
    canAccessTemplate,
} = require('./summaryTemplates');

test('BUILTIN_TEMPLATES holds the five known styles with non-empty prompts', () => {
    const ids = BUILTIN_TEMPLATES.map(t => t.id);
    assert.deepStrictEqual(ids, ['general', 'standup', 'sales', 'interview', 'retrospective']);
    for (const t of BUILTIN_TEMPLATES) {
        assert.ok(t.name && t.nameKey && t.prompt.trim().length > 20, `template ${t.id} well-formed`);
    }
});

test('builtinPrompt returns the matching prompt, and falls back to general for unknown keys', () => {
    assert.strictEqual(builtinPrompt('standup'), BUILTIN_TEMPLATES.find(t => t.id === 'standup').prompt);
    assert.strictEqual(builtinPrompt('does-not-exist'), BUILTIN_TEMPLATES.find(t => t.id === 'general').prompt);
    assert.strictEqual(builtinPrompt(undefined), BUILTIN_TEMPLATES.find(t => t.id === 'general').prompt);
});

test('buildSummarySystemPrompt names the language and appends the template body', () => {
    const out = buildSummarySystemPrompt('DO THE THING', 'nl');
    assert.match(out, /Write the summary in Dutch/);
    assert.match(out, /DO THE THING/);
    // Unknown language code passes through verbatim rather than throwing.
    assert.match(buildSummarySystemPrompt('X', 'xx'), /Write the summary in xx/);
});

// ── pickDefaultTemplate precedence ───────────────────────────────────────────

const P = (over) => ({ id: 'x', scope: 'user', isDefault: true, userId: null, organizationId: null, groupId: null, updatedAt: '2026-01-01', ...over });

test('personal default beats group and org defaults', () => {
    const templates = [
        P({ id: 'u', scope: 'user', userId: 'u1' }),
        P({ id: 'g', scope: 'group', groupId: 'g1' }),
        P({ id: 'o', scope: 'org', organizationId: 'o1' }),
    ];
    const def = pickDefaultTemplate(templates, { userId: 'u1', orgIds: ['o1'], groupIds: ['g1'] });
    assert.strictEqual(def.id, 'u');
});

test('group default beats org default when there is no personal default', () => {
    const templates = [
        P({ id: 'g', scope: 'group', groupId: 'g1' }),
        P({ id: 'o', scope: 'org', organizationId: 'o1' }),
    ];
    const def = pickDefaultTemplate(templates, { userId: 'u1', orgIds: ['o1'], groupIds: ['g1'] });
    assert.strictEqual(def.id, 'g');
});

test('org default applies when no personal/group default is set', () => {
    const templates = [P({ id: 'o', scope: 'org', organizationId: 'o1' })];
    const def = pickDefaultTemplate(templates, { userId: 'u1', orgIds: ['o1'], groupIds: ['g1'] });
    assert.strictEqual(def.id, 'o');
});

test('returns null when there is no applicable default', () => {
    assert.strictEqual(pickDefaultTemplate([], { userId: 'u1', orgIds: ['o1'], groupIds: [] }), null);
    // A default for a group the user is NOT in does not apply.
    const templates = [P({ id: 'g', scope: 'group', groupId: 'other' })];
    assert.strictEqual(pickDefaultTemplate(templates, { userId: 'u1', orgIds: ['o1'], groupIds: ['g1'] }), null);
});

test('only isDefault templates are considered', () => {
    const templates = [
        P({ id: 'u', scope: 'user', userId: 'u1', isDefault: false }),
        P({ id: 'o', scope: 'org', organizationId: 'o1', isDefault: true }),
    ];
    const def = pickDefaultTemplate(templates, { userId: 'u1', orgIds: ['o1'], groupIds: [] });
    assert.strictEqual(def.id, 'o');
});

test('with multiple group defaults, the most recently updated wins (deterministic)', () => {
    const templates = [
        P({ id: 'gA', scope: 'group', groupId: 'g1', updatedAt: '2026-01-01' }),
        P({ id: 'gB', scope: 'group', groupId: 'g2', updatedAt: '2026-06-01' }),
    ];
    const def = pickDefaultTemplate(templates, { userId: 'u1', orgIds: [], groupIds: ['g1', 'g2'] });
    assert.strictEqual(def.id, 'gB');
});

// ── canAccessTemplate ────────────────────────────────────────────────────────

test('canAccessTemplate enforces scope membership', () => {
    const ctx = { userId: 'u1', orgIds: ['o1'], groupIds: ['g1'] };
    assert.ok(canAccessTemplate({ scope: 'user', userId: 'u1' }, ctx));
    assert.ok(!canAccessTemplate({ scope: 'user', userId: 'u2' }, ctx));
    assert.ok(canAccessTemplate({ scope: 'org', organizationId: 'o1' }, ctx));
    assert.ok(!canAccessTemplate({ scope: 'org', organizationId: 'o2' }, ctx));
    assert.ok(canAccessTemplate({ scope: 'group', groupId: 'g1' }, ctx));
    assert.ok(!canAccessTemplate({ scope: 'group', groupId: 'g2' }, ctx));
    assert.ok(!canAccessTemplate(null, ctx));
});
