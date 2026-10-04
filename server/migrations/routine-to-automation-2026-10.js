#!/usr/bin/env node
/**
 * Data migration: the stored word "routine" becomes "automation".
 *
 * The product calls the Studio feature "Automations" and the code now does
 * too. What the code writes changed with it, so the rows it wrote before have
 * to say the same thing, or every reader that filters on the new value
 * silently skips the history:
 *
 *   - log tables (`ai_usage_log`, `ai_task_termination_log`, `guardrail_events`,
 *     `integration_activity_log`): `source` (and `agent_type` on the usage
 *     log) 'routine' → 'automation'. The old value had TWO writers: the
 *     automation runner and the old ai_tasks runner. A row of the second kind
 *     belongs to Cowork, where those tasks moved under their own ids, so a
 *     row whose conversation id is a Cowork schedule becomes 'cowork' and the
 *     rest 'automation'. Where a table has `automation_id`, that decides.
 *     Batched (BATCH rows per statement): the usage log is the largest table
 *     in the database and must not sit under one long lock.
 *   - `connection_grants.resource_type` 'routine' → 'automation' (a lent
 *     connection scoped to one automation), and its CHECK list with it.
 *   - knowledge documents an automation wrote: `documents.source_type`
 *     'routine_write' → 'automation_write' and `metadata.ingestedBy`
 *     'routine' → 'automation'; the matching `kb_sources.config.sourceType`.
 *   - playbooks: the phase kind and key 'routine' → 'automation' in `phases`,
 *     `recipe` and `current_phase`.
 *   - automation definitions: the tool app key 'routine-evolution' →
 *     'automation-evolution' (an ai_step may name it in its app list).
 *   - notifications: the deep-link token `routine_reauth:<provider>` at the
 *     head of a credential-expiry message → `automation_reauth:`.
 *
 * NOT here, on purpose:
 *   - table and column renames (routine_credentials, kb_ingest_routine_id):
 *     the owning stores do those in their initDB, before they read them;
 *   - the vault envelope tag `routine-vault-v1` (stores/orgVault.js): it is
 *     part of every stored ciphertext; renaming it breaks decryption;
 *   - the licence feature id `agent_routines`: the private license server
 *     puts it in customers' keys.
 *
 * Idempotent: every statement matches only the old value, so a second run
 * changes nothing. A table or column that does not exist is skipped.
 * Auto-runs from server boot. Manual usage:
 *   node server/migrations/routine-to-automation-2026-10.js
 */

const { getOne, run } = require('../db');

const BATCH = 10_000;

async function hasColumn(table, column) {
    const r = await getOne(
        `SELECT 1 AS x FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
        [table, column],
    );
    return !!r;
}

async function hasTable(name) {
    const r = await getOne('SELECT to_regclass($1) AS oid', [`public.${name}`]);
    return !!r?.oid;
}

/** Run `sql` (an UPDATE limited to BATCH rows) until it touches nothing; returns the total. */
async function drain(sql, params = []) {
    let total = 0;
    for (;;) {
        const r = await run(sql, params);
        const n = r?.rowCount || 0;
        total += n;
        if (n < BATCH) return total;
    }
}

/**
 * `source` 'routine' → 'cowork' for rows that belong to a Cowork schedule
 * (by `automation_id` when the table has it, else by conversation id), and
 * → 'automation' for the rest. Also `agent_type` where the table has it.
 */
async function relabelLog(table) {
    if (!await hasColumn(table, 'source')) return 0;
    const withAgentType = await hasColumn(table, 'agent_type');
    const withAutomationId = await hasColumn(table, 'automation_id');
    const withConversation = await hasColumn(table, 'conversation_id');
    const coworkExists = await hasTable('cowork_schedules');

    let isCowork = 'FALSE';
    if (withAutomationId) isCowork = 't.automation_id IS NULL';
    else if (withConversation && coworkExists) {
        isCowork = 'EXISTS (SELECT 1 FROM cowork_schedules c WHERE c.id = t.conversation_id)';
    }
    const label = `CASE WHEN ${isCowork} THEN 'cowork' ELSE 'automation' END`;
    const matches = withAgentType ? `(source = 'routine' OR agent_type = 'routine')` : `source = 'routine'`;
    const sets = [`source = CASE WHEN t.source = 'routine' THEN ${label} ELSE t.source END`];
    if (withAgentType) sets.push(`agent_type = CASE WHEN t.agent_type = 'routine' THEN ${label} ELSE t.agent_type END`);

    return drain(
        `UPDATE ${table} t SET ${sets.join(', ')}
          WHERE t.id IN (SELECT id FROM ${table} WHERE ${matches} LIMIT ${BATCH})`,
    );
}

async function up() {
    const summary = {};

    for (const table of ['ai_usage_log', 'ai_task_termination_log', 'guardrail_events', 'integration_activity_log']) {
        if (await hasTable(table)) summary[table] = await relabelLog(table);
    }

    if (await hasColumn('connection_grants', 'resource_type')) {
        // The column is CHECK-constrained to a list that named 'routine'
        // (integration-connections-hardening-2026-07): swap the list around
        // the update, or the update itself is refused.
        await run(`ALTER TABLE connection_grants DROP CONSTRAINT IF EXISTS connection_grants_resource_type_check`);
        const r = await run(`UPDATE connection_grants SET resource_type = 'automation' WHERE resource_type = 'routine'`);
        await run(`ALTER TABLE connection_grants ADD CONSTRAINT connection_grants_resource_type_check
                       CHECK (resource_type IS NULL OR resource_type IN ('agent','webpage','skill','automation','studio_app'))`);
        summary.connection_grants = r?.rowCount || 0;
    }

    if (await hasColumn('documents', 'source_type')) {
        const r = await run(`UPDATE documents SET source_type = 'automation_write' WHERE source_type = 'routine_write'`);
        summary.documents = r?.rowCount || 0;
    }
    if (await hasColumn('documents', 'metadata')) {
        const r = await run(
            `UPDATE documents SET metadata = jsonb_set(metadata::jsonb, '{ingestedBy}', '"automation"')
              WHERE metadata IS NOT NULL AND metadata::jsonb ->> 'ingestedBy' = 'routine'`,
        );
        summary.documentMetadata = r?.rowCount || 0;
    }
    if (await hasColumn('kb_sources', 'config')) {
        const r = await run(
            `UPDATE kb_sources SET config = jsonb_set(config, '{sourceType}', '"automation_write"')
              WHERE config ->> 'sourceType' = 'routine_write'`,
        );
        summary.kb_sources = r?.rowCount || 0;
    }

    if (await hasTable('playbooks')) {
        // The JSONB text form is canonical ("kind": "routine"), so a textual
        // replace of the exact pair is exact; nothing else spells it so.
        const swap = (col) => `REPLACE(REPLACE(${col}::text, '"kind": "routine"', '"kind": "automation"'), '"key": "routine"', '"key": "automation"')::jsonb`;
        const r = await run(
            `UPDATE playbooks
                SET phases = ${swap('phases')},
                    recipe = CASE WHEN recipe IS NULL THEN NULL ELSE ${swap('recipe')} END,
                    current_phase = CASE WHEN current_phase = 'routine' THEN 'automation' ELSE current_phase END
              WHERE phases::text LIKE '%"routine"%'
                 OR (recipe IS NOT NULL AND recipe::text LIKE '%"routine"%')
                 OR current_phase = 'routine'`,
        );
        summary.playbooks = r?.rowCount || 0;
    }

    // A credential-expiry notification starts with a deep-link token the
    // clients parse (`routine_reauth:<provider>`, now `automation_reauth:`).
    if (await hasColumn('notifications', 'message')) {
        const r = await run(
            `UPDATE notifications
                SET message = 'automation_reauth:' || substr(message, ${'routine_reauth:'.length} + 1)
              WHERE message LIKE 'routine\\_reauth:%'`,
        );
        summary.notifications = r?.rowCount || 0;
    }

    // Every stored copy of a definition: the draft, the live one, and history.
    for (const [table, column] of [
        ['automations', 'definition_json'],
        ['automations', 'live_definition_json'],
        ['automation_versions', 'definition_json'],
    ]) {
        if (!await hasColumn(table, column)) continue;
        const r = await run(
            `UPDATE ${table}
                SET ${column} = REPLACE(${column}::text, '"routine-evolution"', '"automation-evolution"')::jsonb
              WHERE ${column}::text LIKE '%"routine-evolution"%'`,
        );
        summary[`${table}.${column}`] = r?.rowCount || 0;
    }

    const changed = Object.values(summary).reduce((a, b) => a + b, 0);
    if (changed > 0) {
        console.log(`[Migration] routine-to-automation-2026-10 applied: ${JSON.stringify(summary)}`);
    }
    return summary;
}

module.exports = { up, relabelLog, BATCH };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
