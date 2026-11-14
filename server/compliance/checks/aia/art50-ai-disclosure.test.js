/**
 * Art. 50 under the concept/live split: the check reads the EFFECTIVE prompt
 * (the published one, else the concept) and the auto-fix writes both columns.
 * On a real Postgres: the boot ladder's schema on PGlite behind db.js's pool.
 *
 * Run: cd server && node --test compliance/checks/aia/art50-ai-disclosure.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { insertRow } = require('../../../testUtils/pgliteSeed');
const { failReads, hideTable } = require('../../../testUtils/pgliteFaults');

const { pg, close } = usePglitePool(ladderPglite());
const db = require('../../../db');

/** Seed the agents of a case. @param {Array<Record<string, unknown>>} list */
async function setAgents(list) {
    await pg.exec('DELETE FROM agents');
    for (const { published_config, ...a } of list) {
        await insertRow(pg, 'agents', { owner_id: 'u1', config: '{}', ...a, ...(published_config ? { published_config } : {}) });
    }
}
/** @param {string} id */
const agentRow = async (id) => (await pg.query('SELECT system_prompt, published_system_prompt FROM agents WHERE id = $1', [id])).rows[0];

/** Every UPDATE the auto-fix sends, from the pool. */
const updates = [];
// When true the database is handed the SELECT without its org predicate and
// parameter, the way a lenient store that drops params would: the check's own
// JS filter must still keep another tenant's agents out.
let ignoreParams = false;
const ORG_PREDICATE = " AND COALESCE(NULLIF(organization_id, ''), 'default') = $1";
const realQuery = db.pool.query;
db.pool.query = /** @type {any} */ (async (/** @type {any} */ sql, /** @type {any} */ params) => {
    const text = String(sql);
    if (/^\s*UPDATE agents/.test(text)) updates.push({ sql: text.replace(/\s+/g, ' ').trim(), params });
    if (ignoreParams && text.includes(ORG_PREDICATE)) return realQuery(text.replace(ORG_PREDICATE, ''), []);
    return realQuery(sql, params);
});

// The install's locale list, for the language of the auto-fix sentence:
// replaced on the configStore object for the whole file.
let defaultLocale = 'en';
const configReads = [];
const configStore = require('../../../stores/configStore');
const savedConfig = { getConfig: configStore.getConfig, setConfig: configStore.setConfig };
configStore.getConfig = /** @type {any} */ (async (/** @type {string} */ key) => {
    configReads.push(key);
    return key === 'i18n_locales' ? [{ code: 'en', isDefault: defaultLocale === 'en' }, { code: 'nl', isDefault: defaultLocale === 'nl' }] : null;
});
configStore.setConfig = /** @type {any} */ (async () => { throw new Error('the auto-fix must not write configuration'); });
test.after(async () => { db.pool.query = realQuery; Object.assign(configStore, savedConfig); await close(); });

const check = require('./art50-ai-disclosure');

test.beforeEach(async () => { await setAgents([]); updates.length = 0; ignoreParams = false; defaultLocale = 'en'; configReads.length = 0; });

/** Run `fn` while the agents table fails with `code`. @param {string} code @param {string} message @param {() => Promise<unknown>} fn */
async function agentsFail(code, message, fn) {
    const undo = code === '42P01' ? await hideTable(pg, 'agents') : await failReads(pg, 'agents', code, message);
    try { return await fn(); } finally { await undo(); }
}

test('the published prompt is what counts: a disclosure only in the draft still warns', async () => {
    await setAgents([{ id: 'a1', name: 'A', is_published: true, system_prompt: 'I am an AI assistant. Draft.', published_system_prompt: 'You are a helpful sales rep.', published_config: {} }]);
    const r = await check.evaluate(null);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.missing_count, 1);
});

test('a disclosure in the published prompt passes even when the draft lost it', async () => {
    await setAgents([{ id: 'a1', name: 'A', is_published: true, system_prompt: 'Nothing here.', published_system_prompt: 'Ik ben een AI-assistent.' }]);
    const r = await check.evaluate(null);
    assert.equal(r.status, 'pass');
});

test('never-published agent: the concept is the effective prompt', async () => {
    await setAgents([{ id: 'a1', name: 'A', is_published: true, system_prompt: 'You are powered by AI.' }]);
    assert.equal((await check.evaluate(null)).status, 'pass');
    await pg.query("UPDATE agents SET system_prompt = 'You are a rep.' WHERE id = 'a1'");
    assert.equal((await check.evaluate(null)).status, 'warn');
});

test('autoFix prepends to BOTH columns for a published agent, and leaves published NULL for an unpublished one', async () => {
    await setAgents([
        { id: 'pub', name: 'P', is_published: true, system_prompt: 'concept', published_system_prompt: 'live' },
        { id: 'draft', name: 'D', is_published: true, system_prompt: 'concept only', published_system_prompt: null },
    ]);
    const r = await check.autoFix(null, { actorId: 'admin' });
    assert.equal(r.changed, 2);
    assert.equal(updates.length, 2);
    // The SELECT projects no agent language, so the install default decides.
    const pub = await agentRow('pub');
    assert.match(pub.system_prompt, /^I am an AI assistant\..*\n\nconcept$/s);
    assert.match(pub.published_system_prompt, /^I am an AI assistant\..*\n\nlive$/s);
    const draft = await agentRow('draft');
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
    await setAgents([{ id: 'a1', name: 'A', is_published: true, organization_id: 'orgB', system_prompt: 'no disclosure' }]);
    assert.equal((await check.evaluate('orgA')).status, 'not_applicable');
    assert.equal((await check.evaluate('orgB')).status, 'warn');
});

test('org scoping: a platform-wide agent (organization_id IS NULL) is not one tenant\'s verdict, and its name never reaches the tenant evidence', async () => {
    await setAgents([
        { id: 'platform', name: 'Platform demo agent', is_published: true, organization_id: null, system_prompt: 'no disclosure here' },
        { id: 'a1', name: 'A', is_published: true, organization_id: 'orgA', system_prompt: 'I am an AI assistant.' },
    ]);
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

    // The scheduler never sweeps null: the 'default' bucket (the org-less
    // users, the only ones who see a platform agent) is where it is judged.
    const bucket = await check.evaluate('default');
    assert.equal(bucket.status, 'warn');
    assert.equal(bucket.evidence.missing_count, 1);
    assert.deepEqual(bucket.evidence.missing_disclosure.map(a => a.id), ['platform']);
    ignoreParams = true;
    assert.deepEqual((await check.evaluate('default')).evidence.missing_disclosure.map(a => a.id), ['platform']);
});

test('autoFix writes the Dutch sentence when the install default language is Dutch', async () => {
    // Agents carry no language (the SELECT projects NULL), so the install
    // default decides.
    defaultLocale = 'nl';
    await setAgents([{ id: 'a1', name: 'A', is_published: true, system_prompt: 'You are a rep.', published_system_prompt: null }]);
    const r = await check.autoFix(null, { actorId: 'admin' });
    assert.equal(r.changed, 1);
    assert.match(updates[0].params[0], /^Ik ben een AI-assistent/);
    assert.equal(r.agents[0].language, 'nl');
    assert.deepEqual(configReads, ['i18n_locales']);
    // The Dutch sentence is itself a disclosure the check recognises.
    assert.equal((await check.evaluate(null)).status, 'pass');

    defaultLocale = 'en';
    await setAgents([{ id: 'a2', name: 'B', is_published: true, system_prompt: 'You are a rep.', published_system_prompt: null }]);
    updates.length = 0;
    await check.autoFix(null, { actorId: 'admin' });
    assert.match(updates[0].params[0], /^I am an AI assistant/);
});

test('a failed register read is its own status — never the reassuring "No agents table yet"', async () => {
    await setAgents([{ id: 'a1', name: 'A', is_published: true, organization_id: 'orgA', system_prompt: 'no disclosure' }]);
    const r = await agentsFail('57014', 'canceling statement due to statement timeout', () => check.evaluate('orgA'));
    assert.equal(r.status, 'warn', 'a check that could not look never answers pass/not_applicable');
    assert.equal(r.evidence.agents_readable, false);
    assert.equal(r.evidence.error_code, '57014');
    assert.match(r.details, /could not be read/);
    assert.doesNotMatch(r.details, /No agents table/);

    // A genuinely unprovisioned install is still not_applicable.
    const na = await agentsFail('42P01', '', () => check.evaluate('orgA'));
    assert.equal(na.status, 'not_applicable');
    assert.match(na.details, /No agents table/);
});

test('autoFix refuses to report success when the register could not be read', async () => {
    await setAgents([{ id: 'a1', name: 'A', is_published: true, organization_id: 'orgA', system_prompt: 'no disclosure' }]);
    await assert.rejects(() => agentsFail('08006', 'connection terminated unexpectedly', () => check.autoFix('orgA', { actorId: 'admin' })), /could not be read/);
    assert.equal(updates.length, 0);
    assert.equal((await agentRow('a1')).system_prompt, 'no disclosure');
});
