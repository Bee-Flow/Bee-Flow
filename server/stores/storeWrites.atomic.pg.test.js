/**
 * Store writes that touch two tables land together or not at all, against a
 * real Postgres (PGlite behind the real db.js). Each case makes the second
 * table refuse the write with a trigger, after the first write of the old
 * step-by-step code had already run, and checks that nothing of the first
 * write remains:
 *
 *   support message + the thread's clock      public-share view + its counter
 *   usage rows + the "indexed" marker         skill activations + last_used_at
 *   custom-check import + framework stamp     workflow folder / workflow + shares
 *   agent category + its agents               KB category + its bases
 *   a KB's move to another organisation + the purge of the old organisation's query log
 *   PII vault entries + counters              query-log acknowledgements + rows
 *   app dataset + its cache
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test stores/storeWrites.atomic.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool(ladderPglite());
const supportStore = require('./supportStore');
const shareStore = require('./webpagePublicShareStore');
const usageStore = require('./automationUsageStore');
const skillActivations = require('./skillActivations');
const customFrameworkStore = require('./customFrameworkStore');
const workflowStore = require('./workflowStore');
const agentCategories = require('./agent/agentCategories');
const { initDB: initAgents } = require('./agent/initSchema');
const knowledgeBases = require('./knowledgeBases');
const piiVaultStore = require('./piiVaultStore');
const queryLog = require('./kb/queryLog/index.mts');
const studioAppData = require('./studioAppDataStore');
const { initDB: initStudioApps } = require('./studioApp/schema');

const REFUSED = 'refused';

/** A trigger on `table` that raises for the rows `when` picks (a condition on NEW or OLD). */
async function refuse(table, timing, when) {
    const name = `refuse_${table}_${timing.split(' ')[1].toLowerCase()}`;
    await pg.exec(`
        CREATE TRIGGER ${name} ${timing} ON ${table}
            FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION refuse_write();
    `);
}

before(async () => {
    for (const init of [supportStore.initDB, shareStore.initDB, usageStore.initDB, skillActivations.initDB,
        customFrameworkStore.initDB, workflowStore.initDB, initAgents, knowledgeBases.initDB, piiVaultStore.initDB,
        initStudioApps, () => studioAppData.ready]) await init();
    await pg.exec(`
        CREATE FUNCTION refuse_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'write refused';
        END $$;
    `);
});
after(close);

const count = async (sql, params = []) => Number((await pg.query(sql, params)).rows[0].n);

test('appendMessage: a failing thread update leaves no message', async () => {
    const thread = await supportStore.createThread({ requesterEmail: 'requester@example.test', source: 'in_app', subject: REFUSED });
    await refuse('support_threads', 'BEFORE UPDATE', `NEW.subject = '${REFUSED}'`);
    await assert.rejects(() => supportStore.appendMessage({ threadId: thread.id, authorKind: 'requester', body: 'hello' }), /write refused/);
    assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM support_messages WHERE thread_id = $1', [thread.id]), 0);
    // An internal note does not move the clock, so it lands.
    assert.ok(await supportStore.appendMessage({ threadId: thread.id, authorKind: 'staff', body: 'note', internalNote: true }));
});

test('recordView: a failing counter update leaves no view row', async () => {
    await pg.query(`INSERT INTO webpages (id, user_id, name) VALUES ('wp-share', 'u1', 'p')`);
    await pg.query(`INSERT INTO webpage_public_shares (id, webpage_id, created_by, token_hash, snapshot_prefix, access_mode)
                    VALUES ('sh-refused', 'wp-share', 'u1', 'th-1', 'p/', 'public'), ('sh-ok', 'wp-share', 'u1', 'th-2', 'q/', 'public')`);
    await refuse('webpage_public_shares', 'BEFORE UPDATE', `NEW.id = 'sh-refused'`);
    await assert.rejects(() => shareStore.recordView('sh-refused', { ip: '192.0.2.1' }), /write refused/);
    assert.strictEqual(await count(`SELECT COUNT(*)::int AS n FROM webpage_public_share_views WHERE share_id = 'sh-refused'`), 0);
    await shareStore.recordView('sh-ok', { ip: '192.0.2.1' });
    assert.strictEqual(await count(`SELECT view_count::int AS n FROM webpage_public_shares WHERE id = 'sh-ok'`), 1);
});

test('purgeUsageForConsumer: a failing marker delete keeps the usage rows', async () => {
    for (const id of [REFUSED, 'app-ok']) {
        await pg.query(`INSERT INTO automation_usage (automation_id, consumer_kind, consumer_id, ref_id, owner_user_id) VALUES ('a1', 'app', $1, 'r1', 'u1')`, [id]);
        await pg.query(`INSERT INTO automation_usage_indexed (consumer_kind, consumer_id) VALUES ('app', $1)`, [id]);
    }
    await refuse('automation_usage_indexed', 'BEFORE DELETE', `OLD.consumer_id = '${REFUSED}'`);
    await assert.rejects(() => usageStore.purgeUsageForConsumer('app', REFUSED), /write refused/);
    assert.strictEqual(await count(`SELECT COUNT(*)::int AS n FROM automation_usage WHERE consumer_id = $1`, [REFUSED]), 1);
    assert.strictEqual(await usageStore.purgeUsageForConsumer('app', 'app-ok'), 1);
    assert.strictEqual(await count(`SELECT COUNT(*)::int AS n FROM automation_usage_indexed WHERE consumer_id = 'app-ok'`), 0);
});

test('recordActivations: a failing last_used_at stamp leaves no activation row', async () => {
    await pg.query(`INSERT INTO skills (id, org_id, user_id, name) VALUES ('sk-refused', 'o1', 'u1', 'S'), ('sk-ok', 'o1', 'u1', 'T')`);
    await refuse('skills', 'BEFORE UPDATE', `NEW.id = 'sk-refused'`);
    assert.strictEqual(await skillActivations.recordActivations({ skillIds: ['sk-refused'], conversationId: 'c1' }), 0);
    assert.strictEqual(await count(`SELECT COUNT(*)::int AS n FROM skill_activations WHERE skill_id = 'sk-refused'`), 0);
    assert.strictEqual(await skillActivations.recordActivations({ skillIds: ['sk-ok'], conversationId: 'c1' }), 1);
    assert.strictEqual(await count(`SELECT COUNT(*)::int AS n FROM skills WHERE id = 'sk-ok' AND last_used_at IS NOT NULL`), 1);
});

test('upsertChecks: a failing framework stamp imports no check', async () => {
    const fw = await customFrameworkStore.createFramework('org-1', { code: 'RF', name: REFUSED });
    await refuse('compliance_custom_frameworks', 'BEFORE UPDATE', `NEW.name = '${REFUSED}'`);
    await assert.rejects(() => customFrameworkStore.upsertChecks('org-1', fw.id, [{ ref: 'A.1', title: 'One' }, { ref: 'A.2', title: 'Two' }]), /write refused/);
    assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM compliance_custom_checks WHERE framework_id = $1', [fw.id]), 0);
});

test('deleteFolder and deleteWorkflow: a failing last delete keeps the workflows and the shares', async () => {
    const folder = await workflowStore.createFolder(REFUSED, null, 'u1');
    const folderId = folder.id ?? folder;
    await workflowStore.createWorkflow({ name: 'in folder', folderId }, 'u1');
    await refuse('folders', 'BEFORE DELETE', `OLD.name = '${REFUSED}'`);
    await assert.rejects(() => workflowStore.deleteFolder(folderId, 'u1'), /write refused/);
    assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM workflows WHERE folder_id = $1', [folderId]), 1);

    const wf = await workflowStore.createWorkflow({ name: REFUSED }, 'u1');
    await workflowStore.shareResource('workflow', wf.id, 'u1', 'u2', 'view');
    await refuse('workflows', 'BEFORE DELETE', `OLD.name = '${REFUSED}'`);
    await assert.rejects(() => workflowStore.deleteWorkflow(wf.id, 'u1'), /write refused/);
    assert.strictEqual(await count(`SELECT COUNT(*)::int AS n FROM shares WHERE resource_type = 'workflow' AND resource_id = $1`, [wf.id]), 1);
});

async function agentIn(categoryId) {
    const id = crypto.randomUUID();
    await pg.query(`INSERT INTO agents (id, name, owner_id, category_id) VALUES ($1, 'A', 'u1', $2)`, [id, categoryId]);
    return id;
}
const categoryOf = async (agentId) => (await pg.query('SELECT category_id FROM agents WHERE id = $1', [agentId])).rows[0].category_id;

test('deleteAgentCategory: a failing delete, or a category of another organisation, keeps the agents in it', async () => {
    const refused = await agentCategories.createAgentCategory('org-1', REFUSED, null, null);
    const a = await agentIn(refused.id);
    await refuse('agent_categories', 'BEFORE DELETE', `OLD.name = '${REFUSED}'`);
    await assert.rejects(() => agentCategories.deleteAgentCategory(refused.id, 'org-1'), /write refused/);
    assert.strictEqual(await categoryOf(a), refused.id);

    const foreign = await agentCategories.createAgentCategory('org-2', 'Theirs', null, null);
    const b = await agentIn(foreign.id);
    assert.strictEqual(await agentCategories.deleteAgentCategory(foreign.id, 'org-1'), false);
    assert.strictEqual(await categoryOf(b), foreign.id);
    assert.strictEqual(await agentCategories.deleteAgentCategory(foreign.id, 'org-2'), true);
    assert.strictEqual(await categoryOf(b), null);
});

test('deleteKBCategory: a failing delete keeps the bases in the category', async () => {
    const cat = await knowledgeBases.createKBCategory({ id: crypto.randomUUID(), organizationId: 'org-1', name: REFUSED });
    const kb = await knowledgeBases.createKB('u1', 'Base', '', 'org-1', { categoryId: cat.id });
    await refuse('kb_categories', 'BEFORE DELETE', `OLD.name = '${REFUSED}'`);
    await assert.rejects(() => knowledgeBases.deleteKBCategory(cat.id), /write refused/);
    assert.strictEqual((await pg.query('SELECT category_id FROM knowledge_bases WHERE id = $1', [kb.id])).rows[0].category_id, cat.id);
});

test('updateKB: a move whose query-log purge fails leaves the base in its organisation', async () => {
    const kb = await knowledgeBases.createKB('u1', REFUSED, '', 'org-1');
    await pg.query('UPDATE knowledge_bases SET query_log_enabled = true WHERE id = $1', [kb.id]);
    await refuse('knowledge_bases', 'BEFORE UPDATE', `OLD.name = '${REFUSED}' AND OLD.query_log_enabled AND NOT NEW.query_log_enabled`);
    await assert.rejects(() => knowledgeBases.updateKB(kb.id, { organizationId: 'org-2' }), /write refused/);
    const row = (await pg.query('SELECT organization_id, query_log_enabled FROM knowledge_bases WHERE id = $1', [kb.id])).rows[0];
    assert.deepStrictEqual(row, { organization_id: 'org-1', query_log_enabled: true });

    const moved = await knowledgeBases.createKB('u1', 'Movable', '', 'org-1');
    await pg.query('UPDATE knowledge_bases SET query_log_enabled = true WHERE id = $1', [moved.id]);
    await knowledgeBases.updateKB(moved.id, { organizationId: 'org-2' }, { actorId: 'u1' });
    const after = (await pg.query('SELECT organization_id, query_log_enabled FROM knowledge_bases WHERE id = $1', [moved.id])).rows[0];
    assert.deepStrictEqual(after, { organization_id: 'org-2', query_log_enabled: false });
    assert.strictEqual(await count(`SELECT COUNT(*)::int AS n FROM access_audit_log WHERE action = 'kb.query_log.purged' AND target_id = $1`, [moved.id]), 1);
});

test('purgeUser: a failing counter delete keeps the vault entries', async () => {
    for (const user of [REFUSED, 'u-ok']) {
        await pg.query(`INSERT INTO pii_vault_entries (id, user_id, category, token, norm_key, value_enc) VALUES ($1, $2, 'EMAIL', 't', 'k', 'v')`, [`e-${user}`, user]);
        await pg.query(`INSERT INTO pii_vault_counters (user_id, category, high_water) VALUES ($1, 'EMAIL', 1)`, [user]);
    }
    await refuse('pii_vault_counters', 'BEFORE DELETE', `OLD.user_id = '${REFUSED}'`);
    await assert.rejects(() => piiVaultStore.purgeUser(REFUSED), /write refused/);
    assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM pii_vault_entries WHERE user_id = $1', [REFUSED]), 1);
    await piiVaultStore.purgeUser('u-ok');
    assert.strictEqual(await count(`SELECT COUNT(*)::int AS n FROM pii_vault_counters WHERE user_id = 'u-ok'`), 0);
});

test('deleteForKb: a failing row delete keeps the acknowledgements', async () => {
    const kb = await knowledgeBases.createKB('u1', 'Logged', '', 'org-1');
    await pg.query('INSERT INTO kb_query_log_ack (user_id, kb_id) VALUES ($1, $2)', ['u1', kb.id]);
    // Statement level: the delete is refused even when it finds no rows.
    await pg.exec(`CREATE TRIGGER refuse_kb_query_log BEFORE DELETE ON kb_query_log FOR EACH STATEMENT EXECUTE FUNCTION refuse_write();`);
    try {
        await assert.rejects(() => queryLog.deleteForKb(kb.id), /write refused/);
    } finally {
        await pg.exec('DROP TRIGGER refuse_kb_query_log ON kb_query_log;');
    }
    assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM kb_query_log_ack WHERE kb_id = $1', [kb.id]), 1);
    await queryLog.deleteForKb(kb.id);
    assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM kb_query_log_ack WHERE kb_id = $1', [kb.id]), 0);
});

test('deleteDataset: a failing dataset delete keeps its cache', async () => {
    await pg.query(`INSERT INTO studio_apps (id, user_id) VALUES ('app-1', 'u1')`);
    await pg.query(`INSERT INTO studio_app_datasets (id, app_id, owner_user_id, name) VALUES ('ds-1', 'app-1', 'u1', $1)`, [REFUSED]);
    await pg.query(`INSERT INTO studio_app_dataset_cache (id, dataset_id, viewer_scope_key, params_hash) VALUES ('c-1', 'ds-1', 'v', 'h')`);
    await refuse('studio_app_datasets', 'BEFORE DELETE', `OLD.name = '${REFUSED}'`);
    await assert.rejects(() => studioAppData.deleteDataset('ds-1', 'app-1', 'u1'), /write refused/);
    assert.strictEqual(await count(`SELECT COUNT(*)::int AS n FROM studio_app_dataset_cache WHERE dataset_id = 'ds-1'`), 1);
});
