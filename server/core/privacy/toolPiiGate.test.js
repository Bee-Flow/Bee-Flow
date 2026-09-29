/**
 * BFSF-354 — the Privacy Shield's tool block lists outside the agent loop.
 *
 * The detector is injected through `_deps`; orgShield loads for real (its
 * classifyToolClass / isBlockedForTool are the matching under test) with only
 * its config store stubbed. Test data is synthetic.
 *
 * Run: cd server && node --test core/privacy/toolPiiGate.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const restore = installResolveStub({
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => true, getAllConfig: async () => ({}) },
});
test.after(() => restore());

const gate = require('./toolPiiGate');

const EMAIL = 'someone@example.test';
const PHONE = '+31 6 0000 0000';

/** A detector that finds the two synthetic values, recording every call. */
function fakeDetector({ degraded = false, throws = false, returns = undefined } = {}) {
    const calls = [];
    const fn = async (text, categories, threshold) => {
        calls.push({ text, categories, threshold });
        if (throws) throw new Error('guard down');
        if (returns !== undefined) return returns;
        const entities = [];
        for (const [value, category, label] of [[EMAIL, 'Email', 'Email Address'], [PHONE, 'Phone', 'Phone Number']]) {
            const i = text.indexOf(value);
            if (i >= 0 && categories.includes(category)) entities.push({ text: value, category, label, offset: i, length: value.length });
        }
        return { hasPii: entities.length > 0, entities, degraded, degradedReason: degraded ? 'guard_unreachable: test' : null };
    };
    fn.calls = calls;
    return fn;
}

const shield = (policy, over = {}) => ({
    enabled: true,
    privacyAction: 'redact',
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] }, ...policy },
    ...over,
});
const OWN_SERVER_EMAIL = shield({ internal: { blockCategories: ['Email'] } });

test.beforeEach(() => { gate._deps.detectPii = fakeDetector(); });

// ── checkToolArgs ───────────────────────────────────────────────────

test('an own-server tool is refused when its arguments carry a blocked category', async () => {
    const r = await gate.checkToolArgs({ toolName: 'notebook_read', args: { note: `mail ${EMAIL}` }, shield: OWN_SERVER_EMAIL });
    assert.strictEqual(r.verdict, 'block');
    assert.strictEqual(r.toolClass, 'internal');
    assert.deepStrictEqual(r.labels, ['Email Address']);
});

test('the own-server list does not reach an outside tool, and vice versa', async () => {
    const r = await gate.checkToolArgs({ toolName: 'gmail_send', args: { to: EMAIL }, shield: OWN_SERVER_EMAIL });
    assert.strictEqual(r.verdict, 'allow');
    assert.strictEqual(gate._deps.detectPii.calls.length, 0, 'an empty list for the class needs no scan');

    const outside = shield({ external: { blockCategories: ['Email'] } });
    assert.strictEqual((await gate.checkToolArgs({ toolName: 'gmail_send', args: { to: EMAIL }, shield: outside })).verdict, 'block');
});

test('a category that is not on the list is allowed', async () => {
    const r = await gate.checkToolArgs({ toolName: 'notebook_read', args: { note: PHONE }, shield: OWN_SERVER_EMAIL });
    assert.strictEqual(r.verdict, 'allow');
});

test('a failed or degraded scan fails closed only for a block-action org', async () => {
    for (const detector of [fakeDetector({ throws: true }), fakeDetector({ degraded: true })]) {
        gate._deps.detectPii = detector;
        const closed = await gate.checkToolArgs({
            toolName: 'notebook_read', args: { note: 'x' }, shield: { ...OWN_SERVER_EMAIL, privacyAction: 'block' },
        });
        assert.strictEqual(closed.verdict, 'unavailable');
        const open = await gate.checkToolArgs({ toolName: 'notebook_read', args: { note: 'x' }, shield: OWN_SERVER_EMAIL });
        assert.strictEqual(open.verdict, 'allow');
    }
});

test('no guard installed (null answer) stays open, and no shield means no scan', async () => {
    gate._deps.detectPii = fakeDetector({ returns: null });
    const r = await gate.checkToolArgs({
        toolName: 'notebook_read', args: { note: EMAIL }, shield: { ...OWN_SERVER_EMAIL, privacyAction: 'block' },
    });
    assert.strictEqual(r.verdict, 'allow');

    gate._deps.detectPii = fakeDetector();
    assert.strictEqual((await gate.checkToolArgs({ toolName: 'notebook_read', args: { note: EMAIL }, shield: null })).verdict, 'allow');
    assert.strictEqual((await gate.checkToolArgs({ toolName: 'notebook_read', args: { note: EMAIL }, shield: { ...OWN_SERVER_EMAIL, enabled: false } })).verdict, 'allow');
    assert.strictEqual(gate._deps.detectPii.calls.length, 0);
});

// ── stripBlockedFromText ────────────────────────────────────────────

test('a blocked category is stripped out of a tool result; the rest stays', async () => {
    const r = await gate.stripBlockedFromText(`contact ${EMAIL} or ${PHONE}`, { toolName: 'kb_search', shield: OWN_SERVER_EMAIL });
    assert.strictEqual(r.text, `contact [blocked:email] or ${PHONE}`);
    assert.strictEqual(r.blockedCount, 1);
    assert.deepStrictEqual(r.redactedLabels, ['Email Address']);
});

test('stripping fails open', async () => {
    gate._deps.detectPii = fakeDetector({ throws: true });
    const text = `contact ${EMAIL}`;
    const r = await gate.stripBlockedFromText(text, { toolName: 'kb_search', shield: OWN_SERVER_EMAIL });
    assert.strictEqual(r.text, text);
    assert.strictEqual(r.blockedCount, 0);
});

// ── stripBlockedFromKbChunks ────────────────────────────────────────

test('injected passages are stripped in place, with ONE guard request for all of them', async () => {
    const chunks = [
        { title: 'A', content: `write to ${EMAIL}` },
        { title: 'B', content: `call ${PHONE}`, snippet: `call ${PHONE}` },
        { title: 'C', content: 'nothing here', snippet: `cc ${EMAIL}` },
    ];
    const r = await gate.stripBlockedFromKbChunks(chunks, OWN_SERVER_EMAIL);
    assert.strictEqual(gate._deps.detectPii.calls.length, 1, 'one bundled scan, not one per chunk');
    assert.deepStrictEqual(gate._deps.detectPii.calls[0].categories, ['Email']);
    assert.strictEqual(chunks[0].content, 'write to [blocked:email]');
    assert.strictEqual(chunks[1].content, `call ${PHONE}`, 'a category not on the list is left alone');
    assert.strictEqual(chunks[2].snippet, 'cc [blocked:email]');
    assert.ok(r.blockedCount >= 1);
});

test('a passage is only stripped by the OWN-SERVER list', async () => {
    const chunks = [{ content: `write to ${EMAIL}` }];
    await gate.stripBlockedFromKbChunks(chunks, shield({ external: { blockCategories: ['Email'] } }));
    assert.strictEqual(chunks[0].content, `write to ${EMAIL}`);
    assert.strictEqual(gate._deps.detectPii.calls.length, 0);
});

test('the source label a passage is shown under goes through the same scan', async () => {
    const chunks = [
        { title: `${EMAIL} — invoice`, content: 'the invoice is attached' },
        { title: 'Pricing', source_uri: 'kb://pricing', content: `call ${PHONE}` },
    ];
    const r = await gate.stripBlockedFromKbChunks(chunks, OWN_SERVER_EMAIL, {
        fields: ['content'], labelOf: c => c.source_uri || c.title,
    });
    assert.strictEqual(gate._deps.detectPii.calls.length, 1, 'labels ride in the same guard request');
    assert.deepStrictEqual(r.sourceLabels, ['[blocked:email] — invoice', 'kb://pricing']);
    assert.strictEqual(chunks[0].title, `${EMAIL} — invoice`, 'the chunk keeps its own title for the citation');
});

test('source labels come back unchanged when nothing applies or the scan fails', async () => {
    const chunks = () => [{ title: `${EMAIL} — invoice`, content: 'x' }];
    const labelOf = c => c.title;
    for (const s of [null, shield({ external: { blockCategories: ['Email'] } })]) {
        const r = await gate.stripBlockedFromKbChunks(chunks(), s, { fields: ['content'], labelOf });
        assert.deepStrictEqual(r.sourceLabels, [`${EMAIL} — invoice`]);
    }
    gate._deps.detectPii = fakeDetector({ throws: true });
    const r = await gate.stripBlockedFromKbChunks(chunks(), OWN_SERVER_EMAIL, { fields: ['content'], labelOf });
    assert.deepStrictEqual(r.sourceLabels, [`${EMAIL} — invoice`], 'fails open');
});

// ── toolLoopGate / resolveToolShield ────────────────────────────────

test('a loop gate refuses and strips for its shield, each audit row naming its tool', async () => {
    const rows = [];
    const loop = gate.toolLoopGate({
        shield: OWN_SERVER_EMAIL, tag: 'Test',
        audit: async (fields, toolName) => { rows.push({ ...fields, toolName }); },
    });
    const refusal = await loop.refuse('notebook_read', { note: `mail ${EMAIL}` });
    assert.match(refusal.modelError, /^Tool 'notebook_read' was not called: its arguments contained Email Address/);
    assert.strictEqual(await loop.refuse('notebook_read', { note: PHONE }), null);
    assert.strictEqual(await loop.forModel(`reach ${EMAIL}`, 'kb_search'), 'reach [blocked:email]');
    assert.deepStrictEqual(rows.map(r => [r.action_taken, r.direction, r.toolName]), [
        ['tool_blocked', 'output', 'notebook_read'],
        ['tool_result_redacted', 'input', 'kb_search'],
    ]);
});

test('a loop gate looks a lazy shield up only when a call needs it, and a failed audit write decides nothing', async () => {
    let lookups = 0;
    const loop = gate.toolLoopGate({
        shield: async () => { lookups++; return OWN_SERVER_EMAIL; }, tag: 'Test',
        audit: async () => { throw new Error('store down'); },
    });
    assert.strictEqual(lookups, 0);
    assert.ok(await loop.refuse('notebook_read', { note: EMAIL }), 'refused without its audit row');
    assert.strictEqual(lookups, 1);
    assert.strictEqual(await gate.toolLoopGate({ shield: null, tag: 'Test' }).forModel(EMAIL, 'kb_search'), EMAIL);
});

test('a failed shield lookup leaves the lists unapplied (null), a good one passes through', async () => {
    assert.strictEqual(await gate.resolveToolShield(async () => { throw new Error('db down'); }, 'Test'), null);
    assert.strictEqual(await gate.resolveToolShield(() => { throw new Error('cannot load'); }, 'Test'), null);
    assert.strictEqual(await gate.resolveToolShield(async () => OWN_SERVER_EMAIL, 'Test'), OWN_SERVER_EMAIL);
});

// ── stripInjectedText / injectedPassagesPrompt ──────────────────────

test('injected text and passages lose what the own-server list forbids, labels included', async () => {
    assert.strictEqual(await gate.stripInjectedText(`billing: ${EMAIL}`, { shield: OWN_SERVER_EMAIL, tag: 'Test' }), 'billing: [blocked:email]');
    const chunks = [
        { title: `${EMAIL} — invoice`, content: `from ${EMAIL}` },
        { title: 'Pricing', source_uri: 'kb://pricing', content: 'the price list' },
        { content: 'untitled' },
    ];
    const text = await gate.injectedPassagesPrompt(chunks, { shield: OWN_SERVER_EMAIL, tag: 'Test' });
    assert.strictEqual(text, [
        '### Source 1: [blocked:email] — invoice\nfrom [blocked:email]',
        '### Source 2: kb://pricing\nthe price list',
        '### Source 3: KB\nuntitled',
    ].join('\n\n'));
    assert.strictEqual(chunks[0].title, `${EMAIL} — invoice`, 'the citation keeps its title');
});
