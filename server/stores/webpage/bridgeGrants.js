// @typecheck
// Runtime bridge grants: the `bridge_grants` column that says what a page's
// script.js may invoke via window.beeflowAI / beeflowAutomations /
// beeflowIntegrations — the normalizer, the whole-column read/write, and the
// atomic single-entry grant/revoke statements.

const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { parseJSON } = require('./shared');
const managedParts = require('../managedPartsDefault');

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

// ── Bridge grants (runtime API allowlist) ─────────────────────────────
//
// The webpage iframe's window.beeflowAI / .beeflowAutomations /
// .beeflowIntegrations bridges run acts-as-author. This column is the
// single source of truth for what the author has explicitly enabled.

// Default per-webpage public-share AI spend cap (rolling 24h, USD), overridable
// per webpage via bridge_grants.ai.publicSpendCapUsd. Clamped to PUBLIC_AI_CAP_MAX.
const PUBLIC_AI_DAILY_CAP_DEFAULT = (() => {
    const v = parseFloat(process.env.PUBLIC_SHARE_AI_DAILY_CAP_USD || '');
    return Number.isFinite(v) && v >= 0 ? v : 2.0;
})();
const PUBLIC_AI_CAP_MAX = 50;

const DEFAULT_BRIDGE_GRANTS = {
    // In-app defaults are permissive (author is authenticated). The `public*`
    // fields govern ANONYMOUS external-share viewers and default OFF — spending
    // the author's LLM budget for strangers must be opted into explicitly.
    /** @type {{enabled: boolean, groundOnPage: boolean, publicEnabled: boolean, publicGroundOnPage: boolean, publicSpendCapUsd: number, publicDefaultTier: string, defaultTier?: string}} */
    ai: {
        enabled: true,
        groundOnPage: true,
        publicEnabled: false,
        publicGroundOnPage: false,
        publicSpendCapUsd: PUBLIC_AI_DAILY_CAP_DEFAULT,
        publicDefaultTier: 'fast',
    },
    automations: [],
    integrations: [],
    // W3: table bindings (window.beeflowTables) and the Agent block. Both start at "nothing": no table
    // bound, no agent chosen. As long as a key is NOT listed here, normalizeBridgeGrants silently throws
    // it away — the column is rebuilt from this fixed shape on every read and write.
    tables: [],
    agent: null,
};

// ── table bindings ────────────────────────────────────────────────────
//
// One binding = one datatable that the page may read via window.beeflowTables (and write with
// mode 'readwrite'). `publicColumns` is a SEPARATE, always narrower gate: the snapshot writer
// renders bf-table server-side from exactly that list, so a column that is not in it never
// leaves /w/<slug>.
//
// Every unreadable value NARROWS, never the other way round:
//   - a mode that is not literally 'readwrite' becomes 'read';
//   - unreadable `columns` become the EMPTY list — and empty here means NO column, not "all".
//     There is deliberately no value that says "everything";
//   - `publicColumns` is trimmed to a subset of `columns`.
const TABLE_WRITE_MODE = 'readwrite';

/** Column keys: only non-empty strings, de-duplicated, order preserved. */
function normalizeColumnKeys(raw) {
    if (!Array.isArray(raw)) return [];
    /** @type {string[]} */
    const out = [];
    for (const c of raw) {
        if (typeof c !== 'string') continue;
        const key = c.trim();
        if (!key || out.includes(key)) continue;
        out.push(key);
    }
    return out;
}

function normalizeTableGrant(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const datatableId = typeof raw.datatableId === 'string' ? raw.datatableId.trim() : '';
    if (!datatableId) return null;
    const columns = normalizeColumnKeys(raw.columns);
    return {
        datatableId,
        // Only the literal string 'readwrite' widens: 'write', 'RW', true, 1, undefined and a missing
        // field are all 'read'.
        mode: raw.mode === TABLE_WRITE_MODE ? TABLE_WRITE_MODE : 'read',
        columns,
        // Never wider than the binding itself. A column that the page does not even read internally
        // cannot be public; with `columns` empty this list is by definition empty too.
        publicColumns: normalizeColumnKeys(raw.publicColumns).filter(c => columns.includes(c)),
    };
}

/**
 * The Agent block: ONE agent, by id, or nothing.
 *
 * Deliberately WITHOUT a `public*` counterpart. ai.ask is deliberately kept out of the anonymous
 * bridge (services/publicShareBridge.js only knows /ai/chat and /ai/stream), so no shape should
 * exist here in which an author could set "public agent". A public agent bridge first requires
 * the A1 confirmation policy and then gets its own explicit field.
 */
function normalizeAgentGrant(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const agentId = typeof raw.agentId === 'string' ? raw.agentId.trim() : '';
    return agentId ? { agentId } : null;
}

function normalizeBridgeGrants(raw) {
    const out = {
        ai: { ...DEFAULT_BRIDGE_GRANTS.ai },
        automations: [],
        integrations: [],
        tables: [],
        agent: null,
    };
    if (raw && typeof raw === 'object') {
        if (raw.ai && typeof raw.ai === 'object') {
            out.ai.enabled = raw.ai.enabled !== false;
            out.ai.groundOnPage = raw.ai.groundOnPage !== false;
            if (typeof raw.ai.defaultTier === 'string') out.ai.defaultTier = raw.ai.defaultTier;
            // Public-share (anonymous) AI — default OFF unless explicitly true.
            out.ai.publicEnabled = raw.ai.publicEnabled === true;
            out.ai.publicGroundOnPage = raw.ai.publicGroundOnPage === true;
            if (typeof raw.ai.publicDefaultTier === 'string') out.ai.publicDefaultTier = raw.ai.publicDefaultTier;
            const cap = parseFloat(raw.ai.publicSpendCapUsd);
            if (Number.isFinite(cap) && cap >= 0) {
                out.ai.publicSpendCapUsd = Math.min(cap, PUBLIC_AI_CAP_MAX);
            }
        }
        if (Array.isArray(raw.automations)) {
            out.automations = raw.automations
                .filter(e => e && typeof e.automationId === 'string')
                .map(e => ({ automationId: e.automationId, ...(e.label ? { label: String(e.label) } : {}) }));
        }
        if (Array.isArray(raw.integrations)) {
            out.integrations = raw.integrations
                .filter(e => e && typeof e.tool === 'string')
                .map(e => ({
                    tool: e.tool,
                    ...(e.fixedArgs && typeof e.fixedArgs === 'object' ? { fixedArgs: e.fixedArgs } : {}),
                    ...(e.label ? { label: String(e.label) } : {}),
                }));
        }
        if (Array.isArray(raw.tables)) {
            // De-duplicated on datatableId. Two bindings for the same table make "which one applies?"
            // depend on whether a reader uses .find() or .filter() — and then sometimes the broader of
            // the two wins. The last entry wins, just like the atomic upsert below.
            const byId = new Map();
            for (const e of raw.tables) {
                const clean = normalizeTableGrant(e);
                if (clean) byId.set(clean.datatableId, clean);
            }
            out.tables = [...byId.values()];
        }
        out.agent = normalizeAgentGrant(raw.agent);
    }
    return out;
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
 * `tables` / `agent`) you supply replaces the corresponding slice wholesale. To incrementally
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
    const merged = normalizeBridgeGrants({
        ai: patch?.ai !== undefined ? patch.ai : current.ai,
        automations: patch?.automations !== undefined ? patch.automations : current.automations,
        integrations: patch?.integrations !== undefined ? patch.integrations : current.integrations,
        tables: patch?.tables !== undefined ? patch.tables : current.tables,
        agent: patch?.agent !== undefined ? patch.agent : current.agent,
    });
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

/** @typedef {{enabled: boolean, groundOnPage: boolean, publicEnabled: boolean, publicGroundOnPage: boolean, publicSpendCapUsd: number, publicDefaultTier: string, defaultTier?: string}} AiGrant */

/** @typedef {{ automationId: string, label?: string }} AutomationGrant */

/** @typedef {{ tool: string, fixedArgs?: Record<string, any>, label?: string }} IntegrationGrant */

/** @typedef {{ datatableId: string, mode: string, columns: string[], publicColumns: string[] }} TableGrant */

/** @typedef {{ agentId: string }} AgentGrant */

/** @typedef {{ ai: AiGrant, automations: AutomationGrant[], integrations: IntegrationGrant[], tables: TableGrant[], agent: AgentGrant | null }} BridgeGrants */

/** @typedef {'integrations' | 'automations' | 'tables'} GrantList */
