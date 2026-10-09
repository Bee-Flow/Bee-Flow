'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveWebResearch, runWebResearchTool, webResearchPromptLine, RESULT_MAX_CHARS } = require('./webResearch');
const { toolAllowed, MODES } = require('./workMode');

const TOOLS = [{ function: { name: 'agent_search' } }, { function: { name: 'read_url' } }];

function deps(over = {}) {
    const calls = { permitted: [], runs: [], pii: [], rows: [] };
    return {
        calls,
        providerStatus: async () => ({ available: true }),
        isPermitted: async (o) => { calls.permitted.push(o); return true; },
        getShield: async () => null,
        tools: () => TOOLS,
        run: async (name, args, egress) => { calls.runs.push({ name, args, egress }); return 'search text'; },
        detectPii: async (text, cats) => { calls.pii.push({ text, cats }); return { hasPii: false }; },
        logGuardrailEvent: (row) => { calls.rows.push(row); return Promise.resolve(); },
        ...over,
    };
}

const base = { requested: true, userId: 'u1', orgId: 'org1' };

test('offered only when the toggle is on, a provider exists and the app is permitted', async () => {
    const d = deps();
    const on = await resolveWebResearch(base, d);
    assert.equal(on.offered, true);
    assert.deepEqual(on.tools.map(t => t.function.name), ['agent_search', 'read_url']);
    assert.equal(d.calls.permitted[0].appId, 'agent-search');

    assert.equal((await resolveWebResearch({ ...base, requested: false }, deps())).reason, 'off');
    assert.equal((await resolveWebResearch(base, deps({ providerStatus: async () => ({ available: false }) }))).reason, 'not_configured');
    assert.equal((await resolveWebResearch(base, deps({ isPermitted: async () => false }))).reason, 'not_permitted');
});

test('not offered: no tools at all', async () => {
    const r = await resolveWebResearch({ ...base, requested: false }, deps());
    assert.deepEqual(r.tools, []);
    assert.equal(r.offered, false);
});

test('the org\'s no-search-with-files policy holds for this turn\'s files and earlier ones', async () => {
    const shield = { enabled: true, disableSearchOnUpload: true };
    const d = deps({ getShield: async () => shield });
    assert.equal((await resolveWebResearch({ ...base, attachments: [{ name: 'a.pdf' }] }, d)).reason, 'upload_policy');
    assert.equal((await resolveWebResearch({ ...base, history: [{ role: 'user', attachments: [{ name: 'a.pdf' }] }] }, d)).reason, 'upload_policy');
    assert.equal((await resolveWebResearch(base, d)).offered, true);
});

test('a failing gate fails closed', async () => {
    const r = await resolveWebResearch(base, deps({ providerStatus: async () => { throw new Error('db down'); } }));
    assert.equal(r.offered, false);
    assert.equal(r.reason, 'unavailable');
});

test('the Web Search Guard categories come from the enabled shield', async () => {
    const shield = { enabled: true, webSearchGuardPiiCategories: ['email'], webSearchGuardEnabled: true };
    const r = await resolveWebResearch(base, deps({ getShield: async () => shield }));
    assert.deepEqual(r.guard, { piiCategories: ['email'], block: true });
});

test('a personal account (no org) gets its own resolved shield, as in direct chat', async () => {
    const asked = [];
    const shield = { enabled: true, disableSearchOnUpload: true, webSearchGuardEnabled: true, webSearchGuardPiiCategories: ['person'] };
    const d = deps({ getShield: async (ids) => { asked.push(ids); return shield; } });
    assert.equal((await resolveWebResearch({ requested: true, userId: 'u1', orgId: null, attachments: [{ name: 'a.pdf' }] }, d)).reason, 'upload_policy');
    const r = await resolveWebResearch({ requested: true, userId: 'u1', orgId: null }, d);
    assert.deepEqual(r.guard, { piiCategories: ['person'], block: true });
    assert.deepEqual(asked[0], { orgId: null, userId: 'u1' });
});

test('every work mode allows the read-only web tools', () => {
    for (const mode of MODES) {
        assert.equal(toolAllowed('agent_search', mode), true, mode);
        assert.equal(toolAllowed('read_url', mode), true, mode);
    }
});

const offered = { offered: true, guard: { piiCategories: [], block: false } };
const ids = { userId: 'u1', orgId: 'org1', automationId: 'a1', modelId: 'm' };

test('a call runs the search with the builder\'s egress attribution', async () => {
    const d = deps();
    const out = await runWebResearchTool('agent_search', { query: 'Inserve API' }, { research: offered, gate: null, ids }, d);
    assert.deepEqual(out.result, { ok: true, text: 'search text' });
    assert.equal(out.modelText, 'search text');
    assert.equal(d.calls.runs[0].egress.source, 'automation_builder');
    assert.deepEqual(d.calls.runs[0].egress.ids, { organization_id: 'org1', user_id: 'u1', automation_id: 'a1' });
});

test('read_url is guarded on its URL and find text', async () => {
    const d = deps();
    const research = { offered: true, guard: { piiCategories: ['email'], block: false } };
    await runWebResearchTool('read_url', { url: 'https://docs.example.test', find: 'tickets' }, { research, gate: null, ids }, d);
    assert.equal(d.calls.pii[0].text, 'https://docs.example.test tickets');
});

test('the Web Search Guard blocks a query with personal data when blocking is on, and logs it', async () => {
    const d = deps({ detectPii: async () => ({ hasPii: true, entities: [{ label: 'email' }] }) });
    const research = { offered: true, guard: { piiCategories: ['email'], block: true } };
    const out = await runWebResearchTool('agent_search', { query: 'jan@example.test' }, { research, gate: null, ids }, d);
    assert.match(out.result.error, /blocked/);
    assert.equal(d.calls.runs.length, 0);
    assert.equal(d.calls.rows[0].action_taken, 'search_blocked');
    assert.equal(d.calls.rows[0].source, 'automation_builder');
});

test('monitoring only: the search still runs and the detection is logged', async () => {
    const d = deps({ detectPii: async () => ({ hasPii: true, entities: [{ label: 'email' }] }) });
    const research = { offered: true, guard: { piiCategories: ['email'], block: false } };
    const out = await runWebResearchTool('agent_search', { query: 'q' }, { research, gate: null, ids }, d);
    assert.equal(out.result.ok, true);
    assert.equal(d.calls.rows[0].action_taken, 'pii_detected');
});

test('the Privacy Shield tool gate can refuse the call before it runs', async () => {
    const d = deps();
    const gate = { refuse: async () => ({ modelError: 'refused by shield' }) };
    const out = await runWebResearchTool('agent_search', { query: 'q' }, { research: offered, gate, ids }, d);
    assert.equal(out.result.error, 'refused by shield');
    assert.equal(out.modelText, null);
    assert.equal(d.calls.runs.length, 0);
});

test('not offered, empty query, search error: refused with an error', async () => {
    const d = deps();
    assert.ok((await runWebResearchTool('agent_search', { query: 'q' }, { research: { offered: false }, ids }, d)).result.error);
    assert.ok((await runWebResearchTool('agent_search', { query: ' ' }, { research: offered, ids }, d)).result.error);
    const failing = deps({ run: async () => ({ error: 'Agent Search URL not configured.' }) });
    assert.match((await runWebResearchTool('agent_search', { query: 'q' }, { research: offered, ids }, failing)).result.error, /not configured/);
    const throwing = deps({ run: async () => { throw new Error('boom'); } });
    assert.match((await runWebResearchTool('agent_search', { query: 'q' }, { research: offered, ids }, throwing)).result.error, /boom/);
    assert.equal(d.calls.runs.length, 0);
});

test('a long result is cut so it cannot crowd out the draft', async () => {
    const d = deps({ run: async () => 'x'.repeat(RESULT_MAX_CHARS + 500) });
    const out = await runWebResearchTool('read_url', { url: 'https://a.test' }, { research: offered, ids }, d);
    assert.ok(out.modelText.length < RESULT_MAX_CHARS + 100);
    assert.match(out.modelText, /cut at/);
});

test('prompt line: tells the model to look things up itself, or honestly that it cannot', () => {
    assert.match(webResearchPromptLine({ offered: true }), /instead of asking the user to search/);
    const off = webResearchPromptLine({ offered: false, reason: 'off' });
    assert.match(off, /never claim you did/);
    assert.match(off, /switch Web search on/);
    assert.doesNotMatch(webResearchPromptLine({ offered: false, reason: 'not_configured' }), /switch Web search on/);
    assert.equal(webResearchPromptLine(null), null);
});
