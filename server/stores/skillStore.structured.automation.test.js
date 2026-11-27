// @typecheck
/**
 * skillStore — the usage scan over automations (module "automation"): an AI
 * step by its skillIds, the summary per kind, a missing automations table
 * named rather than folded into an empty list, any other failure rethrown.
 * The rest of the structured-fields store: skillStore.structured.test.js.
 *
 * Against a real Postgres: the boot ladder's schema on PGlite
 * (testUtils/pgliteTemplate.js ladderPglite) behind db.js's pool, so the
 * agents and automations the usage scan reads are real rows too.
 *
 * Run: node --test stores/skillStore.structured.automation.test.js
 */

'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { usePglitePool } = require('../testUtils/pglitePool');
const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { insertRow } = require('../testUtils/pgliteSeed');
const { failReads, hideTable } = require('../testUtils/pgliteFaults');

const { pg, close } = usePglitePool(ladderPglite());
const store = require('./skillStore');

// Requiring the store starts the user store's schema in the background (stores/user/groups.js,
// roles.js); wait for it, so its transaction is not open on the one PGlite session when a test
// renames a column.
before(async () => { await store.initDB(); await require('./userStore').initDB(); });
after(close);
beforeEach(() => pg.exec('TRUNCATE skills, skill_test_runs, agents, automations CASCADE'));

// ── usage ────────────────────────────────────────────────────────────

const agent = (over) => insertRow(pg, 'agents', { owner_id: 'owner', organization_id: 'org1', ...over });
const automation = (over) => insertRow(pg, 'automations', { user_id: 'colleague', organization_id: 'org1', title: 'A', definition_json: { steps: [] }, ...over });

test('the usage scan finds an agent by an element of attachedSkillIds and an AI step by its skillIds, scoped to the org', async () => {
    await agent({ id: 'a1', name: 'Offerte-assistent', config: JSON.stringify({ attachedSkillIds: ['sk1', 'sk3'] }) });
    await agent({ id: 'a-key', name: 'Key only', config: JSON.stringify({ sk1: true, attachedSkillIds: [] }) });
    await agent({ id: 'a-empty', name: 'Empty config', config: '' });
    await agent({ id: 'a-object', name: 'Object', config: JSON.stringify({ attachedSkillIds: { sk1: 1 } }) });
    await agent({ id: 'a-org2', name: 'Other org', organization_id: 'org2', config: JSON.stringify({ attachedSkillIds: ['sk1'] }) });
    await automation({
        id: 'au1', title: 'Offerte versturen', last_run_at: '2026-09-02T00:00:00Z', is_active: true,
        definition_json: { steps: [{ id: 'ai_3', label: '3', type: 'ai_step', skillIds: ['sk1'] }, { id: 'x', type: 'http', skillIds: ['sk1'] }] },
    });
    await automation({ id: 'au2', title: 'Layered', definition_json: { steps: [], layers: { inner: { steps: [{ id: 'ai_9', type: 'ai_step', skillIds: ['sk1'] }] } } } });
    await automation({ id: 'au-org2', organization_id: 'org2', definition_json: { steps: [{ id: 's', type: 'ai_step', skillIds: ['sk1'] }] } });

    const usage = await store.listSkillUsage('sk1', 'org1');
    assert.deepStrictEqual(usage, {
        rows: [
            { kind: 'agent', id: 'a1', title: 'Offerte-assistent', role: 'chat', lastAt: null, ownerId: 'owner' },
            { kind: 'automation', id: 'au1', title: 'Offerte versturen', role: 'ai_step', siteLabel: 'step 3', stepId: 'ai_3', layerKey: null, lastAt: '2026-09-02T00:00:00.000Z', ownerId: 'colleague' },
            { kind: 'automation', id: 'au2', title: 'Layered', role: 'ai_step', siteLabel: 'step ai_9', stepId: 'ai_9', layerKey: 'inner', lastAt: null, ownerId: 'colleague' },
        ],
        unchecked: [],
    }, "a top-level key is not an element, '' and a non-array never abort the scan, another org is never read");
});

/** An install whose agents table predates published_config. */
async function withoutPublishedConfig(fn) {
    await pg.exec('ALTER TABLE agents RENAME COLUMN published_config TO published_config_aside');
    try { return await fn(); } finally { await pg.exec('ALTER TABLE agents RENAME COLUMN published_config_aside TO published_config'); }
}

test('an install without agents.published_config narrows to the draft scan instead of failing', async () => {
    await agent({ id: 'a1', name: 'Offerte-assistent', config: JSON.stringify({ attachedSkillIds: ['sk1'] }) });
    const usage = await withoutPublishedConfig(() => store.listSkillUsage('sk1', 'org1'));
    assert.deepStrictEqual(usage.rows.map((r) => r.id), ['a1'], 'and it still answers');
    assert.deepStrictEqual(usage.unchecked, [], 'the agents fallback is a narrowing, not a gap');
});

test('an unused skill yields no rows and no gaps — the shape the 409 guard and the delete dialog rely on', async () => {
    await agent({ id: 'a1', name: 'Other skill', config: JSON.stringify({ attachedSkillIds: ['sk2'] }) });
    assert.deepStrictEqual(await store.listSkillUsage('sk1', 'org1'), { rows: [], unchecked: [] });
    assert.deepStrictEqual(await store.listSkillUsage('', 'org1'), { rows: [], unchecked: [] });
});

/**
 * An install with no automations has no `automations` table. That is
 * supported, but it is not a count either: "No agent or automation uses this
 * skill yet" must not be printable over a kind nobody scanned.
 */
test('a missing automations table is NAMED, not folded into an empty list', async () => {
    await agent({ id: 'a1', name: 'Offerte-assistent', config: JSON.stringify({ attachedSkillIds: ['sk1'] }) });
    const restore = await hideTable(pg, 'automations');
    try {
        const usage = await store.listSkillUsage('sk1', 'org1');
        assert.deepStrictEqual(usage.unchecked, ['automation']);
        assert.strictEqual(usage.rows.length, 1, 'the agents half still answers');
        const sum = await store.getUsageSummary('org1', ['sk1']);
        assert.strictEqual(sum.sk1.automationsUnchecked, true);
        assert.strictEqual(sum.sk1.automations, 0, 'the number stays 0; the flag is what says it was never counted');
    } finally { await restore(); }
});

test('and any OTHER failure of the step scan is still rethrown', async () => {
    const restore = await failReads(pg, 'automations', '08006', 'connection terminated');
    try {
        await assert.rejects(() => store.listSkillUsage('sk1', 'org1'), /connection terminated/);
    } finally { await restore(); }
});

test('getUsageSummary counts per kind, both agent copies, and an agent carrying the skill in both counts ONCE', async () => {
    await agent({ id: 'a1', name: 'Both', config: JSON.stringify({ attachedSkillIds: ['sk1'] }), published_config: { attachedSkillIds: ['sk1'] } });
    await agent({ id: 'a2', name: 'Published', config: '', published_config: { attachedSkillIds: ['sk1'] } });
    await agent({ id: 'a3', name: 'Not an array', config: JSON.stringify({ attachedSkillIds: 'sk1' }) });
    await automation({ id: 'au1', definition_json: { steps: [{ id: 'a', type: 'ai_step', skillIds: ['sk1'] }, { id: 'b', type: 'ai_step', skillIds: ['sk1'] }] } });
    const sum = await store.getUsageSummary('org1', ['sk1', 'sk9']);
    assert.deepStrictEqual(sum, { sk1: { agents: 2, automations: 1, lastUsedAt: null }, sk9: { agents: 0, automations: 0, lastUsedAt: null } });
});

test('the summary also survives an install without agents.published_config', async () => {
    await agent({ id: 'a1', name: 'Draft', config: JSON.stringify({ attachedSkillIds: ['sk1'] }) });
    const sum = await withoutPublishedConfig(() => store.getUsageSummary('org1', ['sk1']));
    assert.deepStrictEqual(sum, { sk1: { agents: 1, automations: 0, lastUsedAt: null } });
});

