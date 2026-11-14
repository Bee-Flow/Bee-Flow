// @typecheck
/**
 * The structured role at STORE level (A1c): who gets a persona, who never
 * does, and the undefined-means-preserve rule on the way in.
 *
 * The two properties worth a test each:
 *   - `persona` is an EDITOR artefact. `parseConfig` strips the raw column, so
 *     it can only appear where this file deliberately puts it — never on a
 *     list, a runtime projection or the published library, all of which are
 *     built from `SELECT *`.
 *   - the write follows the same rule the three other optional columns learned
 *     the hard way: an argument nobody supplied preserves, it does not clear.
 *
 * Against a real Postgres (PGlite behind db.js's pool, testUtils/pglitePool.js)
 * with the agent store's own schema; the persona projection is swapped on its
 * module object (testUtils/swaps.js) to reach "the projection is unavailable".
 *
 * Run: cd server && node --test stores/agent/agentCrud.persona.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { usePglitePool } = require('../../testUtils/pglitePool');
const { insertRow } = require('../../testUtils/pgliteSeed');
const { makeSwaps } = require('../../testUtils/swaps');

const { pg, close } = usePglitePool();
const agentSchema = require('./initSchema');
const agentCrud = require('./agentCrud');
const personaPrompt = require('../../core/agentRuntime/personaPrompt');

const { swap, restore } = makeSwaps();

test.before(async () => {
    await pg.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, "organizationId" TEXT)`);
    await agentSchema.initDB();
    await require('../versionStore').initDB();
});
test.beforeEach(() => pg.exec('TRUNCATE agents, agent_versions CASCADE'));
test.after(async () => { restore(); await close(); });

/** An agent row as another writer left it. */
function seed(id, extra = {}) {
    return insertRow(pg, 'agents', {
        id, owner_id: 'owner', name: 'seed', rev: 1, is_published: true,
        system_prompt: 'the live prompt', config: JSON.stringify({ knowledge_base_ids: [] }),
        shared_groups: '[]', organization_id: null, published_version: 0,
        ...extra,
    });
}
const storedPersona = async (id) => (await pg.query('SELECT persona FROM agents WHERE id = $1', [id])).rows[0].persona;
const versions = async () => (await pg.query('SELECT * FROM agent_versions ORDER BY created_at')).rows;
const breakProjection = () => swap(personaPrompt, 'personaOf', () => { throw new Error('personaPrompt is unreachable'); });

const FIELDS_PERSONA = {
    who: 'You are the Acme concierge.',
    does: ['Book meeting rooms'],
    unknown: { mode: 'honest', automationId: null },
    mode: 'fields',
};

// ── Who sees a persona ──────────────────────────────────────────────

test('getAgent carries the persona; getForRuntime does not', async () => {
    await seed('a1', { persona: FIELDS_PERSONA });

    const draft = /** @type {any} */ (await agentCrud.getAgent('a1'));
    assert.strictEqual(draft.persona.who, 'You are the Acme concierge.');
    assert.strictEqual(draft.persona.mode, 'fields');

    const runtime = await agentCrud.getForRuntime('a1');
    assert.ok(!('persona' in runtime),
        'the runtime reads the GENERATED prompt; a persona there is a second description nobody checked');
});

test('a NULL persona column reads back as free mode over the concept prompt', async () => {
    // The whole "migration" for every agent that predates the column — computed
    // on read, so no pass ever rewrites a live row.
    await seed('a1', { persona: null, system_prompt: 'You answer questions about invoices.' });
    const draft = /** @type {any} */ (await agentCrud.getAgent('a1'));
    assert.strictEqual(draft.persona.mode, 'free');
    assert.strictEqual(draft.persona.freeText, 'You answer questions about invoices.');
    assert.strictEqual(await storedPersona('a1'), null, 'nothing was written back');
});

test('getAgentViews puts the persona on the DRAFT only', async () => {
    await seed('a1', {
        persona: FIELDS_PERSONA,
        published_version: 2, published_rev: 1,
        published_config: { knowledge_base_ids: [] }, published_system_prompt: 'the published prompt',
    });
    const views = /** @type {any} */ (await agentCrud.getAgentViews('a1'));
    assert.strictEqual(views.draft.persona.who, 'You are the Acme concierge.');
    assert.ok(!('persona' in views.runtime),
        'the concept persona describes the concept prompt — pairing it with the published one is a claim nobody made');
    assert.strictEqual(views.runtime.system_prompt, 'the published prompt');
});

test('the raw column never rides along on a list read', async () => {
    await seed('a1', { persona: FIELDS_PERSONA });
    await seed('a2', { persona: FIELDS_PERSONA });
    // The library leaves out agents whose owner no longer exists.
    await pg.query(`INSERT INTO users (id) VALUES ('owner') ON CONFLICT DO NOTHING`);

    const mine = await agentCrud.getAgents('owner');
    assert.strictEqual(mine.length, 2);
    for (const a of mine) assert.ok(!('persona' in a), 'the library serves what runs, and a persona is not part of it');
    const published = await agentCrud.getPublishedAgentsForUser([], null, new Set());
    assert.strictEqual(published.length, 2);
    for (const a of published) assert.ok(!('persona' in a), 'anyone who can see a published agent would otherwise get its editor fields');
});

// ── The write ───────────────────────────────────────────────────────

/** updateAgent with the positional arguments every test here shares. */
const update = (id, opts) => agentCrud.updateAgent(id, 'n', 'd', 'sp', 'owner', null, [], null, true, true, false, {}, false, null, undefined, undefined, opts);

test('updateAgent without a persona option leaves the column untouched', async () => {
    await seed('a1', { persona: FIELDS_PERSONA });
    const res = await update('a1', {});
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(await storedPersona('a1'), FIELDS_PERSONA, 'a caller that never heard of personas cannot erase one');
    const row = (await pg.query('SELECT name, system_prompt FROM agents WHERE id = $1', ['a1'])).rows[0];
    assert.deepStrictEqual(row, { name: 'n', system_prompt: 'sp' }, 'the rest of the update did land');
});

test('updateAgent writes a supplied persona, and an explicit null clears it', async () => {
    await seed('a1');
    await update('a1', { persona: FIELDS_PERSONA });
    assert.deepStrictEqual(await storedPersona('a1'), FIELDS_PERSONA);

    await update('a1', { persona: null });
    assert.strictEqual(await storedPersona('a1'), null);
});

test('with a persona clause in the SET list the rev guard still bites', async () => {
    await seed('a1', { rev: 7 });
    const ok = await update('a1', { expectedRev: 7, persona: FIELDS_PERSONA });
    assert.strictEqual(ok.ok, true);
    assert.deepStrictEqual(await storedPersona('a1'), FIELDS_PERSONA);

    const stale = /** @type {any} */ (await update('a1', { expectedRev: 7, persona: { ...FIELDS_PERSONA, who: 'a stale tab' } }));
    assert.strictEqual(stale.conflict, true, 'the CAS token still bites with a persona clause in the SET list');
    assert.strictEqual((await storedPersona('a1')).who, 'You are the Acme concierge.', 'and the stale write changed nothing');
});

test('createAgent stores the persona it is given, and NULL when it is given none', async () => {
    const withPersona = await agentCrud.createAgent('n', 'd', 'sp', 'owner', null, [], true, true, false, {}, null, [], null, { persona: FIELDS_PERSONA });
    assert.deepStrictEqual(await storedPersona(withPersona.id), FIELDS_PERSONA);

    const without = await agentCrud.createAgent('n', 'd', 'sp', 'owner');
    assert.strictEqual(await storedPersona(without.id), null,
        'a caller that knows nothing about personas creates exactly what it always created');
});

test('when the projection is unavailable the key is OMITTED, never set to null', async () => {
    // A client re-syncs from this payload and sends it back. A `persona: null`
    // born from a FAILED READ would return as an explicit "clear the column"
    // and delete a role nobody touched — the read becoming a decision.
    await seed('a1', { persona: FIELDS_PERSONA });
    const undo = breakProjection();
    try {
        const draft = /** @type {any} */ (await agentCrud.getAgent('a1'));
        assert.ok(!('persona' in draft), 'a missing key means preserve, all the way down to the SET list');

        const views = /** @type {any} */ (await agentCrud.getAgentViews('a1'));
        assert.ok(!('persona' in views.draft));
        assert.strictEqual(views.draft.name, 'seed', 'and the rest of the agent still loads');
    } finally { undo(); }
});

// ── snapshotAgent: the undo point of a refinement ───────────────────

test('snapshotAgent snapshots the RAW row, not the view of getAgent', async () => {
    await seed('a1', { persona: FIELDS_PERSONA, config: JSON.stringify({ memoryEnabled: true }) });

    const created = await agentCrud.snapshotAgent('a1', 'u1', { kind: 'pre_refine' });
    assert.strictEqual(created.kind, 'pre_refine');

    const [v] = await versions();
    assert.strictEqual(v.id, created.id);
    assert.strictEqual(v.agent_id, 'a1');
    assert.strictEqual(v.agent_type, 'agent');
    assert.strictEqual(v.created_by, 'u1');
    assert.strictEqual(typeof v.change_summary, 'string', 'its own summary, so createVersion need not invent one');
    const snapshot = typeof v.snapshot === 'string' ? JSON.parse(v.snapshot) : v.snapshot;
    // The raw shape: config as JSON text, persona as the column itself.
    assert.strictEqual(snapshot.config, JSON.stringify({ memoryEnabled: true }));
    assert.strictEqual(snapshot.owner_id, 'owner', 'restore writes with this owner_id — it has to be in there');
});

test('a broken persona projection does not make the snapshot persona-less', async () => {
    // This is why snapshotAgent does NOT read via getAgent(): there `persona`
    // drops away on a read error, and the restore reads such a missing key as
    // null and writes the column empty. The raw row carries it in any case.
    await seed('a1', { persona: FIELDS_PERSONA });
    const undo = breakProjection();
    try {
        const view = await agentCrud.getAgent('a1');
        assert.ok(!('persona' in view), 'the view does leave it out — that is the danger');
        await agentCrud.snapshotAgent('a1', 'u1', { kind: 'pre_refine' });
    } finally { undo(); }
    const [v] = await versions();
    const snapshot = typeof v.snapshot === 'string' ? JSON.parse(v.snapshot) : v.snapshot;
    assert.deepStrictEqual(snapshot.persona, FIELDS_PERSONA, 'the snapshot keeps the role');
});

test('snapshotAgent of an unknown agent gives null and writes no version', async () => {
    const created = await agentCrud.snapshotAgent('nope', 'u1', { kind: 'pre_refine' });
    assert.strictEqual(created, null, '"nothing to restore" is something other than "a snapshot of nothing"');
    assert.deepStrictEqual(await versions(), []);
});
