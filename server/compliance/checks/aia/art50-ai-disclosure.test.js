/**
 * Art. 50 under the concept/live split: the check reads the EFFECTIVE prompt
 * (COALESCE(published_system_prompt, system_prompt)) and the auto-fix writes
 * both columns. `db` is mocked via require.cache.
 *
 * Run: cd server && node --test --test-force-exit compliance/checks/aia/art50-ai-disclosure.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

let agents = [];
const updates = [];
// Set to an Error to make the next agent read fail (a dropped connection, a
// statement timeout, a missing table — the SQLSTATE decides how it is read).
let readError = null;
// When true the fake ignores the org predicate + its parameter, the way a
// lenient stub or a store that drops params would: the check's own JS filter
// must still keep another tenant's agents out.
let ignoreParams = false;
const flat = (sql) => String(sql).replace(/\s+/g, ' ').trim();

// Emulates the SELECT's COALESCE projection and org predicate over the
// in-memory rows.
const fakeDb = {
    async getAll(sql, params = []) {
        if (readError) throw readError;
        const s = flat(sql);
        assert.match(s, /COALESCE\(published_system_prompt, system_prompt\) AS system_prompt/);
        assert.match(s, /COALESCE\(published_config::text, config::text\) AS config/);
        const scoped = /AND organization_id = \$1/.test(s);
        assert.equal(scoped, params.length === 1, 'the org predicate and its parameter must travel together');
        const rows = scoped && !ignoreParams
            ? agents.filter(a => (a.organization_id ?? null) === params[0])
            : agents;
        return rows.filter(a => a.is_published).map(a => ({
            id: a.id, name: a.name,
            system_prompt: a.published_system_prompt ?? a.system_prompt,
            draft_system_prompt: a.system_prompt,
            published_system_prompt: a.published_system_prompt ?? null,
            starter_prompts: a.starter_prompts ?? '[]',
            config: a.published_config != null ? JSON.stringify(a.published_config) : (a.config ?? '{}'),
            organization_id: a.organization_id ?? null,
            language: a.language ?? null,
        }));
    },
    async run(sql, params) {
        const s = flat(sql);
        updates.push({ sql: s, params });
        const [draft, published, id] = params;
        const a = agents.find(x => x.id === id);
        if (!a) return { rowCount: 0 };
        a.system_prompt = draft;
        a.published_system_prompt = published;
        return { rowCount: 1 };
    },
    async exec() {},
    async getOne() { return null; },
};

const dbPath = require.resolve(path.join(__dirname, '..', '..', '..', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const check = require('./art50-ai-disclosure');

test.beforeEach(() => { agents = []; updates.length = 0; readError = null; ignoreParams = false; });

function pgError(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
}

test('the published prompt is what counts: a disclosure only in the draft still warns', async () => {
    agents = [{ id: 'a1', name: 'A', is_published: true, system_prompt: 'I am an AI assistant. Draft.', published_system_prompt: 'You are a helpful sales rep.', published_config: {} }];
    const r = await check.evaluate(null);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.missing_count, 1);
});

test('a disclosure in the published prompt passes even when the draft lost it', async () => {
    agents = [{ id: 'a1', name: 'A', is_published: true, system_prompt: 'Nothing here.', published_system_prompt: 'Ik ben een AI-assistent.' }];
    const r = await check.evaluate(null);
    assert.equal(r.status, 'pass');
});

test('never-published agent: the concept is the effective prompt', async () => {
    agents = [{ id: 'a1', name: 'A', is_published: true, system_prompt: 'You are powered by AI.' }];
    assert.equal((await check.evaluate(null)).status, 'pass');
    agents[0].system_prompt = 'You are a rep.';
    assert.equal((await check.evaluate(null)).status, 'warn');
});

test('autoFix prepends to BOTH columns for a published agent, and leaves published NULL for an unpublished one', async () => {
    agents = [
        { id: 'pub', name: 'P', is_published: true, language: 'nl', system_prompt: 'concept', published_system_prompt: 'live' },
        { id: 'draft', name: 'D', is_published: true, system_prompt: 'concept only', published_system_prompt: null },
    ];
    const r = await check.autoFix(null, { actorId: 'admin' });
    assert.equal(r.changed, 2);
    assert.equal(updates.length, 2);
    for (const u of updates) {
        assert.match(u.sql, /SET system_prompt = \$1, published_system_prompt = \$2/);
    }
    const pub = agents.find(a => a.id === 'pub');
    assert.match(pub.system_prompt, /^Ik ben een AI-assistent\..*\n\nconcept$/s);
    assert.match(pub.published_system_prompt, /^Ik ben een AI-assistent\..*\n\nlive$/s);
    const draft = agents.find(a => a.id === 'draft');
    assert.match(draft.system_prompt, /^I am an AI assistant\..*\n\nconcept only$/s);
    assert.equal(draft.published_system_prompt, null, 'an unpublished agent must not be flipped into split mode by the fix');
    // Evidence records the EFFECTIVE before/after.
    const ev = r.agents.find(a => a.agent_id === 'pub');
    assert.equal(ev.before_prompt, 'live');
    assert.equal(ev.published_updated, true);
    assert.match(ev.after_prompt, /\n\nlive$/);
    // And the check passes afterwards.
    assert.equal((await check.evaluate(null)).status, 'pass');
});

test('org scoping and no-agents still behave', async () => {
    agents = [{ id: 'a1', name: 'A', is_published: true, organization_id: 'orgB', system_prompt: 'no disclosure' }];
    assert.equal((await check.evaluate('orgA')).status, 'not_applicable');
    assert.equal((await check.evaluate('orgB')).status, 'warn');
});

test('org scoping: a platform-wide agent (organization_id IS NULL) is not one tenant\'s verdict, and its name never reaches the tenant evidence', async () => {
    agents = [
        { id: 'platform', name: 'Platform demo agent', is_published: true, organization_id: null, system_prompt: 'no disclosure here' },
        { id: 'a1', name: 'A', is_published: true, organization_id: 'orgA', system_prompt: 'I am an AI assistant.' },
    ];
    const r = await check.evaluate('orgA');
    assert.equal(r.status, 'pass', 'an agent that belongs to no organisation is not orgA\'s to fail on');
    assert.equal(r.evidence.total_published, 1);
    assert.equal(r.evidence.missing_count, 0);
    assert.equal(JSON.stringify(r.evidence).includes('platform'), false, 'no other-scope agent id/name in this org\'s evidence chain');

    // Same guarantee when the SQL predicate is not honoured: the check's own
    // filter must mirror it, or one org's agent lands in another org's ledger.
    ignoreParams = true;
    const lenient = await check.evaluate('orgA');
    assert.equal(lenient.status, 'pass');
    assert.equal(lenient.evidence.total_published, 1);
    assert.equal(JSON.stringify(lenient.evidence).includes('platform'), false);

    // And nobody's verdict silently swallows it: with no org in scope the
    // platform-wide agent is assessed as before.
    ignoreParams = false;
    const global = await check.evaluate(null);
    assert.equal(global.status, 'warn');
    assert.equal(global.evidence.missing_count, 1);
});

test('a failed register read is its own status — never the reassuring "No agents table yet"', async () => {
    agents = [{ id: 'a1', name: 'A', is_published: true, organization_id: 'orgA', system_prompt: 'no disclosure' }];
    readError = pgError('canceling statement due to statement timeout', '57014');
    const r = await check.evaluate('orgA');
    assert.equal(r.status, 'warn', 'a check that could not look never answers pass/not_applicable');
    assert.equal(r.evidence.agents_readable, false);
    assert.equal(r.evidence.error_code, '57014');
    assert.match(r.details, /could not be read/);
    assert.doesNotMatch(r.details, /No agents table/);

    // A genuinely unprovisioned install is still not_applicable.
    readError = pgError('relation "agents" does not exist', '42P01');
    const na = await check.evaluate('orgA');
    assert.equal(na.status, 'not_applicable');
    assert.match(na.details, /No agents table/);
});

test('autoFix refuses to report success when the register could not be read', async () => {
    agents = [{ id: 'a1', name: 'A', is_published: true, organization_id: 'orgA', system_prompt: 'no disclosure' }];
    readError = pgError('connection terminated unexpectedly', '08006');
    await assert.rejects(() => check.autoFix('orgA', { actorId: 'admin' }), /could not be read/);
    assert.equal(updates.length, 0);
});
