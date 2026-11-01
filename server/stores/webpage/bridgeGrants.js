// @typecheck
// Runtime bridge grants: the `bridge_grants` column that says what a page's
// script.js may invoke via window.beeflowAI / beeflowAutomations /
// beeflowIntegrations — the normalizer, the whole-column read/write, and the
// atomic single-entry grant/revoke statements.

const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { parseJSON } = require('./shared');
const managedParts = require('../managedPartsDefault');
const { DEFAULT_BRIDGE_GRANTS, normalizeBridgeGrants, mergeGrantPatch } = require('./bridgeGrantsShape');

// ── The managed-part guard for webpage writes ─────────────────────────
//
// A page filed into a Solution STAGE project (UAT/PRD) is managed
// (stores/lib/managedParts.js): its files, metadata, grants and published
// pointer change only through a deploy, which passes `managedWrite`
// ({ deploymentId }). Publish/audience, access mode, public share, the page's
// own data.db and its thumbnail stay editable (ALLOWED.webpage).
//
// It lives in this module because this is the leaf every webpage aggregate
// can require without a cycle (webpages.js, versions.js and the facade all
// do), and because the grant writers here are also called directly, not
// only through the facade (routes/webpagesAudience.js).

/**
 * Refuse a write to a managed page unless every changed key is allow-listed
 * or the write carries the deploy's capability. A page outside a stage
 * project passes untouched.
 *
 * @param {string} webpageId
 * @param {string[]} changedKeys
 * @param {{ managedWrite?: { deploymentId?: string }|null, client?: any, projectId?: string|null }} [opts]
 *        `projectId`: the page's project when the caller already read it (skips the lookup)
 */
async function assertWebpageWrite(webpageId, changedKeys, { managedWrite = null, client = null, projectId = undefined } = {}) {
    if (!webpageId) return { managed: false };
    let pid = projectId;
    if (pid === undefined) {
        if (!client) await initDB();
        const sql = 'SELECT project_id FROM webpages WHERE id = $1';
        const row = client ? (await client.query(sql, [webpageId])).rows[0] : await getOne(sql, [webpageId]);
        pid = row ? row.project_id : null;
    }
    if (!pid) return { managed: false };
    return managedParts.assertManagedWrite({ kind: 'webpage', projectId: pid, changedKeys, managedWrite, client });
}

// The grant lists that hold pointers a release carries: a change to one of
// them is a managed write. `ai` and `integrations` stay the stage's own
// (integration grants are never carried; design section 2).
const MANAGED_GRANT_LISTS = Object.freeze(['automations', 'tables']);

/** A table binding without its public column gate (the public share is a stage setting). */
const withoutPublicGate = (tables) => (tables || []).map(({ publicColumns, ...rest }) => rest);

/** The managed grant slices that differ between two normalised grant sets. */
function changedManagedGrants(before, after) {
    /** @type {string[]} */
    const keys = [];
    if (JSON.stringify(before.automations) !== JSON.stringify(after.automations)) keys.push('bridgeGrants.automations');
    if (JSON.stringify(withoutPublicGate(before.tables)) !== JSON.stringify(withoutPublicGate(after.tables))) keys.push('bridgeGrants.tables');
    if (JSON.stringify(before.agent) !== JSON.stringify(after.agent)) keys.push('bridgeGrants.agent');
    return keys;
}

/**
 * @param {string} webpageId
 */
async function getBridgeGrants(webpageId) {
    await initDB();
    const r = await getOne('SELECT bridge_grants FROM webpages WHERE id = $1', [webpageId]);
    return normalizeBridgeGrants(r ? parseJSON(r.bridge_grants, null) : null);
}

/**
 * Owner-only write. `patch` is a partial — any kind (`ai` / `automations` / `integrations` /
 * `tables` / `agent` / `db`) you supply replaces the corresponding slice wholesale. To incrementally
 * add/remove a single grant, read first, mutate, write.
 *
 * `agent: null` is a valid value (clears the agent); only `undefined` leaves the current one in
 * place. Hence the !== undefined check everywhere.
 * @param {string} webpageId
 * @param {string} userId
 */

async function updateBridgeGrants(webpageId, userId, patch, opts = {}) {
    await initDB();
    const current = await getBridgeGrants(webpageId);
    const merged = normalizeBridgeGrants(mergeGrantPatch(current, patch));
    // Only a change to a carried pointer is a managed write: narrowing a
    // table's public columns (the public share) or the AI switches is not.
    const managedKeys = changedManagedGrants(current, merged);
    if (managedKeys.length > 0) await assertWebpageWrite(webpageId, managedKeys, opts);
    const { rowCount } = await run(
        `UPDATE webpages SET bridge_grants = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3`,
        [JSON.stringify(merged), webpageId, userId]
    );
    if (rowCount === 0) return null;
    return merged;
}

// ── atomic single-entry grant/revoke ─────────────────────────────────────────
// updateBridgeGrants() writes the WHOLE bridge_grants column after reading it,
// so two concurrent single-entry changes lose each other: the studio AI grants
// several tools in one parallel tool-call burst, every call reads the same
// `integrations` array, appends its own entry, and the last write wins — the
// author is told five tools were granted and two land. These helpers do the
// read-modify-write inside ONE statement, so Postgres' row lock serialises them.
//
// `list` is the bridge_grants key ('integrations' | 'automations' | 'tables')
// and `idKey` the field identifying an entry ('tool' | 'automationId' |
// 'datatableId'). Both are chosen by this module, never by a caller — they are
// interpolated into SQL.
/** @type {Record<string, string>} */
const GRANT_LISTS = {
    integrations: 'tool',
    automations: 'automationId',
    // Tabelbindingen lopen langs dezelfde atomaire weg: de Data-tab schakelt ze
    // per tabel aan/uit, en twee gelijktijdige schakelaars mogen elkaar net zo
    // min verliezen als de tool-grants dat mochten.
    tables: 'datatableId',
};

/**
 * @param {boolean} withAppend
 * @param {string} list
 */
function _grantListSql(list, withAppend) {
    const idKey = GRANT_LISTS[list];
    // Rebuild the array without the entry being replaced, then optionally append
    // the new one. COALESCE keeps a NULL/absent column or list working.
    const kept = `COALESCE((
        SELECT jsonb_agg(e)
        FROM jsonb_array_elements(COALESCE(bridge_grants->'${list}', '[]'::jsonb)) AS e
        WHERE e->>'${idKey}' IS DISTINCT FROM $3
    ), '[]'::jsonb)`;
    const value = withAppend ? `${kept} || jsonb_build_array($4::jsonb)` : kept;
    return `UPDATE webpages
            SET bridge_grants = jsonb_set(COALESCE(bridge_grants, '{}'::jsonb), '{${list}}', ${value}),
                updated_at = NOW()
            WHERE id = $1 AND user_id = $2
            RETURNING bridge_grants`;
}

/**
 * The managed-list guard for a single-entry write. Reads the OWNER's row
 * first, so a caller who does not own the page gets null (not managed_part
 * details). A no-op passes the guard, the same rule updateBridgeGrants
 * applies by diffing before it refuses: removing an absent id answers the
 * current grants without a write; re-granting an unchanged entry writes unguarded.
 * @returns {Promise<{ result: any }|null>} `{ result }` to answer at once, null to go on and write
 * @param {string} webpageId
 * @param {string} list
 * @param {string} id
 */
async function guardManagedEntry(webpageId, userId, list, id, clean, opts) {
    if (!MANAGED_GRANT_LISTS.includes(list)) return null;
    const row = await getOne('SELECT bridge_grants, project_id FROM webpages WHERE id = $1 AND user_id = $2', [webpageId, userId]);
    if (!row) return { result: null };
    const current = normalizeBridgeGrants(parseJSON(row.bridge_grants, null));
    const existing = current[list].find(e => e[GRANT_LISTS[list]] === id);
    if (!clean && !existing) return { result: current };
    // Re-granting the same pointer (a public column gate is the stage's own) still writes, unguarded.
    if (clean && existing && JSON.stringify(withoutPublicGate([existing])) === JSON.stringify(withoutPublicGate([clean]))) return null;
    await assertWebpageWrite(webpageId, [`bridgeGrants.${list}`], { ...opts, projectId: row.project_id || null });
    return null;
}

/**
 * Add (or replace) one entry in a bridge-grant list, atomically.
 * @returns the full normalized grants after the write, or null when the page
 *          does not exist / is not owned by `userId`.
 * @param {string} webpageId
 * @param {string} list
 */
async function upsertBridgeGrantEntry(webpageId, userId, list, entry, opts = {}) {
    if (!GRANT_LISTS[list]) throw new Error(`upsertBridgeGrantEntry: unknown list "${list}"`);
    await initDB();
    const idKey = GRANT_LISTS[list];
    const id = entry && entry[idKey];
    if (typeof id !== 'string' || !id) throw new Error(`upsertBridgeGrantEntry: entry.${idKey} is required`);
    // Normalize the single entry through the shared normalizer so the shape
    // written here can never drift from the whole-column path.
    const [clean] = normalizeBridgeGrants({ [list]: [entry] })[list];
    if (!clean) throw new Error(`upsertBridgeGrantEntry: invalid ${list} entry`);
    const early = await guardManagedEntry(webpageId, userId, list, id, clean, opts);
    if (early) return early.result;
    const r = await getOne(_grantListSql(list, true), [webpageId, userId, id, JSON.stringify(clean)]);
    if (!r) return null;
    return normalizeBridgeGrants(parseJSON(r.bridge_grants, null));
}

/**
 * Remove one entry from a bridge-grant list, atomically. Same return contract
 * as upsertBridgeGrantEntry; removing something absent is a no-op success.
 * @param {string} webpageId
 * @param {string} list
 * @param {string} id
 */
async function removeBridgeGrantEntry(webpageId, userId, list, id, opts = {}) {
    if (!GRANT_LISTS[list]) throw new Error(`removeBridgeGrantEntry: unknown list "${list}"`);
    await initDB();
    if (typeof id !== 'string' || !id) throw new Error('removeBridgeGrantEntry: id is required');
    const early = await guardManagedEntry(webpageId, userId, list, id, null, opts);
    if (early) return early.result;
    const r = await getOne(_grantListSql(list, false), [webpageId, userId, id]);
    if (!r) return null;
    return normalizeBridgeGrants(parseJSON(r.bridge_grants, null));
}

/**
 * Check whether `kind` (`ai` / `automation` / `integration`) for `key` is
 * granted on this webpage. Returns the grant entry (or `true` for ai) when
 * allowed, `null` when not.
 * @param {string} webpageId
 */
async function checkGrant(webpageId, kind, key) {
    const g = await getBridgeGrants(webpageId);
    if (kind === 'ai') return g.ai.enabled ? g.ai : null;
    if (kind === 'automation') {
        return g.automations.find(e => e.automationId === key) || null;
    }
    if (kind === 'integration') {
        return g.integrations.find(e => e.tool === key) || null;
    }
    return null;
}

/**
 * Which pages are bound to THIS table — and keep a public address for it?
 *
 * The reverse direction of all the other reads here: not "what may this page do", but "who hangs
 * off this table". The W5 reconciler uses it to refresh every public snapshot after a row
 * mutation — see core/webpages/webpageShareReconciler.js for why that is a GDPR path.
 *
 * Two things determine the shape of this query:
 *
 *  1. `@>` on JSONB, not a LIKE on the text. A table id also appears in `columns` or in a label,
 *     and a text match would pick up pages that are not bound to this table at all.
 *  2. `public_share_id IS NOT NULL`. A page without a public address has no snapshot to refresh.
 *     This filter lives in the DATABASE and not in the caller, so that a loop over a thousand
 *     bound pages does not become a thousand when only three are public.
 */
async function listPublicWebpagesBoundToDatatable(datatableId) {
    await initDB();
    if (typeof datatableId !== 'string' || !datatableId) return [];
    const rows = await getAll(
        `SELECT id, user_id, public_share_id
           FROM webpages
          WHERE public_share_id IS NOT NULL
            AND bridge_grants -> 'tables' @> $1::jsonb`,
        [JSON.stringify([{ datatableId }])],
    );
    return (rows || []).map(r => ({
        webpageId: r.id,
        ownerId: r.user_id,
        publicShareId: r.public_share_id || null,
    }));
}

module.exports = {
    DEFAULT_BRIDGE_GRANTS,
    assertWebpageWrite,
    listPublicWebpagesBoundToDatatable,
    normalizeBridgeGrants,
    getBridgeGrants,
    updateBridgeGrants,
    upsertBridgeGrantEntry,
    removeBridgeGrantEntry,
    checkGrant,
};

/** @typedef {import('./bridgeGrantsShape').AiGrant} AiGrant */
/** @typedef {import('./bridgeGrantsShape').AutomationGrant} AutomationGrant */
/** @typedef {import('./bridgeGrantsShape').IntegrationGrant} IntegrationGrant */
/** @typedef {import('./bridgeGrantsShape').TableGrant} TableGrant */
/** @typedef {import('./bridgeGrantsShape').AgentGrant} AgentGrant */
/** @typedef {import('./bridgeGrantsShape').BridgeGrants} BridgeGrants */

/** @typedef {'integrations' | 'automations' | 'tables'} GrantList */
