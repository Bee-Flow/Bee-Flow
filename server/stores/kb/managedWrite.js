// @typecheck strict
/**
 * stores/kb/managedWrite.js — the Solution-stage write guard of a knowledge
 * base: refuse a change to a managed base without a deployment's capability,
 * and the "what actually changes" diff of an updateKB. Split out of
 * stores/knowledgeBases.js; the barrel builds it over the app's guard.
 */

const { KB_UPDATE_COLUMNS } = require('./model');

// ── Knowledge bases in a Solution stage (design 5.2, 5.3) ──────────
// A base stamped into (or listed on) a UAT / PRD stage project is MANAGED.
// Its metadata and its deletion change only through a deploy. Its documents
// stay the stage's own in shell mode; when the Solution carries the base's
// content ('carry'), documents change only through a deploy too. Publishing
// and audience (setPublished) are always the stage's own. A deploy passes its
// capability as `managedWrite` (stores/lib/managedParts.js).


/**
 * @param {any} managedParts  stores/managedPartsDefault.js (or a test's double
 *        of it): managedInfoForKb, assertManagedWrite, changedKeysOf
 */
function makeKbWriteGuard(managedParts) {

    /**
     * Refuse `changedKeys` on a managed base without a deployment's capability.
     * `carryOnly`: a document write, which only a carried base guards.
     *
     * @param {string} kbId
     * @param {string[]} changedKeys
     * @param {{ deploymentId?: string }|null|undefined} managedWrite
     * @param {{ carryOnly?: boolean }} [opts]
     */
    async function assertKbWrite(kbId, changedKeys, managedWrite, { carryOnly = false } = {}) {
        if (!kbId || changedKeys.length === 0) return;
        const info = await managedParts.managedInfoForKb(String(kbId));
        if (!info) return;
        if (carryOnly && info.contentMode !== 'carry') return;
        await managedParts.assertManagedWrite({
            kind: info.contentMode === 'carry' ? 'knowledge_base_carry' : 'knowledge_base',
            projectId: info.stageProjectId,
            changedKeys,
            managedWrite: managedWrite || null,
        });
    }

    /**
     * The update keys whose value would change the row: `updateKB` COALESCEs, so
     * a null leaves a column as it is, except `categoryId: null`, which clears.
     * @param {Record<string, unknown> | null} row  the row as read under the lock
     * @param {Record<string, unknown> | null | undefined} fields
     */
    function kbUpdateChanges(row, fields) {
        /** @type {Record<string, unknown>} */
        const incoming = {};
        for (const [k, v] of Object.entries(fields || {})) {
            if (v === undefined) continue;
            if (v === null && k !== 'categoryId') continue;
            incoming[k] = v;
        }
        return managedParts.changedKeysOf(row, incoming, KB_UPDATE_COLUMNS);
    }

    return { assertKbWrite, kbUpdateChanges };
}

module.exports = { makeKbWriteGuard };
