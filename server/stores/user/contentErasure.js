// @typecheck strict
/**
 * The account-erasure steps that erasureCoverage.js drives: the person's
 * conversations and messages, their own rows, and the references on
 * organisation and project records. The stores that keep bytes outside
 * Postgres are reached through the `content` erasure port, never required
 * from here (stores/user/erasurePorts.js explains the loop that would close).
 *
 * Every function takes deleteUser's `step(name, fn)`: one table or store per
 * step, so a failure is reported by name and the other tables still run. A
 * table an install does not have is not a failure (step() reads
 * isMissingTable). Each step is idempotent, so a reported-incomplete erasure
 * can simply be retried.
 *
 * Table and column names come from erasureCoverage.js, a frozen map in this
 * repository, never from a caller — which is the only reason they may be
 * interpolated into SQL here.
 */

'use strict';

const { run, getAll } = require('../../db');
const log = require('../../telemetry/log');
const { isMissingTable } = require('../../utils/isMissingTable');
const { entriesOf } = require('./erasureCoverage');

/** @typedef {(name: string, fn: () => Promise<unknown>) => Promise<void>} Step */
/** @typedef {import('./erasurePorts').ErasurePorts['content']} ContentPort */

/** @param {string} name */
const ident = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** A statement that may name a table this install does not have. @param {string} sql @param {unknown[]} params */
const runIfPresent = (sql, params) => run(sql, params).catch((e) => { if (!isMissingTable(e)) throw e; });

/**
 * Chat: the messages live in their own table with no FK to either
 * conversation table, so the conversations alone are not the content. The
 * messages go first, by conversation id; a message the person wrote in a
 * colleague's conversation keeps its text and loses the author (the same
 * answer as project team chat).
 * @param {string} userId
 * @param {Step} step
 */
async function eraseConversations(userId, step) {
    await step('conversations', async () => {
        await runIfPresent(
            `DELETE FROM conversation_messages WHERE conversation_id IN (
                 SELECT id FROM agent_conversations WHERE user_id = $1
                 UNION SELECT id FROM direct_conversations WHERE user_id = $1)`,
            [userId]);
        await run('DELETE FROM agent_conversations WHERE user_id = $1', [userId]);
        await run('DELETE FROM direct_conversations WHERE user_id = $1', [userId]);
        await runIfPresent('UPDATE conversation_messages SET author_user_id = NULL WHERE author_user_id = $1', [userId]);
    });
}

/**
 * The person's own rows: deleted, one table per step.
 * @param {string} userId
 * @param {Step} step
 */
async function eraseOwnedRows(userId, step) {
    for (const [table, { column, detach }] of entriesOf('deleted')) {
        await step(table, async () => {
            await run(`DELETE FROM ${ident(table)} WHERE ${ident(column)} = $1`, [userId]);
            // A second author column on the same table (an organisation
            // template the person wrote): the row stays, the reference goes.
            if (detach) await run(`UPDATE ${ident(table)} SET ${ident(detach)} = NULL WHERE ${ident(detach)} = $1`, [userId]);
        });
    }
}

/**
 * Organisation and project records that merely name the person: the
 * reference is cleared, the record stays (the column is nullable, which the
 * footprint test checks against the schema).
 * @param {string} userId
 * @param {Step} step
 */
async function detachRecordRefs(userId, step) {
    for (const [table, { column }] of entriesOf('detached')) {
        await step(table, async () => {
            for (const col of column.split(',')) {
                await run(`UPDATE ${ident(table)} SET ${ident(col)} = NULL WHERE ${ident(col)} = $1`, [userId]);
            }
        });
    }
}

/**
 * The same, where the author column is NOT NULL: the record is handed on.
 *
 *   - a record under an organisation goes to that organisation's oldest
 *     remaining org_admin (`oldestOrgAdmin`, the datatable rule); a record
 *     with no organisation was nobody else's and is deleted; an organisation
 *     without an admin left is logged loudly and the row keeps the id, as a
 *     shared datatable does;
 *   - a record under a parent row (a project's task, a colleague's app
 *     version) goes to the parent's owner, read in the same UPDATE.
 *
 * @param {string} userId
 * @param {Step} step
 * @param {(organizationId: string, excludeUserId: string) => Promise<string | null>} oldestOrgAdmin
 */
async function reassignRecordRefs(userId, step, oldestOrgAdmin) {
    for (const [table, entry] of entriesOf('reassigned')) {
        await step(table, async () => {
            const col = ident(entry.column);
            if ('via' in entry) {
                const { parent, key, owner } = entry.via;
                await run(
                    `UPDATE ${ident(table)} t SET ${col} = p.${ident(owner)}
                       FROM ${ident(parent)} p
                      WHERE p.id = t.${ident(key)} AND t.${col} = $1`,
                    [userId]);
                return;
            }
            const org = ident(entry.org);
            await run(`DELETE FROM ${ident(table)} WHERE ${col} = $1 AND ${org} IS NULL`, [userId]);
            const orgs = await getAll(`SELECT DISTINCT ${org} AS org FROM ${ident(table)} WHERE ${col} = $1`, [userId]);
            for (const { org: orgId } of orgs) {
                const heir = await oldestOrgAdmin(orgId, userId);
                if (!heir) {
                    log.error(`[UserStore] ${table} rows of org '${orgId}' have no org_admin to inherit them; they still name deleted user '${userId}'`);
                    continue;
                }
                await run(`UPDATE ${ident(table)} SET ${col} = $2 WHERE ${col} = $1 AND ${org} = $3`, [userId, heir, orgId]);
            }
        });
    }
}

/**
 * Everything erasureCoverage.js names, in order: the content stores (bytes
 * outside Postgres first, while the rows that locate them exist), the
 * person's own rows, the references on records that stay, and finally
 * whatever is left under their object-storage prefix.
 * @param {string} userId
 * @param {Step} step
 * @param {{ content: ContentPort, oldestOrgAdmin: (organizationId: string, excludeUserId: string) => Promise<string | null> }} deps
 */
async function eraseContent(userId, step, { content, oldestOrgAdmin }) {
    await step('transcriptions', () => content.eraseTranscriptions(userId));
    await step('webpages', () => content.eraseWebpages(userId));
    await step('studio apps', () => content.eraseStudioApps(userId));
    await step('skills', () => content.eraseSkills(userId));
    await eraseOwnedRows(userId, step);
    await detachRecordRefs(userId, step);
    await reassignRecordRefs(userId, step, oldestOrgAdmin);
    await step('object storage', () => content.eraseStoragePrefix(userId));
}

module.exports = { eraseConversations, eraseOwnedRows, detachRecordRefs, reassignRecordRefs, eraseContent };
