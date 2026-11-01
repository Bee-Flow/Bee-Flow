// @typecheck strict
// The SHAPE of a page's bridge grants (the `bridge_grants` column): the defaults,
// and the normalizer that rebuilds the column from that fixed shape on every read
// and write, so an unknown key or an unreadable value never survives. No database
// here; ./bridgeGrants.js owns the reads, writes and the managed-part guard.

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

/** @typedef {{enabled: boolean, groundOnPage: boolean, publicEnabled: boolean, publicGroundOnPage: boolean, publicSpendCapUsd: number, publicDefaultTier: string, defaultTier?: string}} AiGrant */
/** @typedef {{ automationId: string, label?: string }} AutomationGrant */
/** @typedef {{ tool: string, fixedArgs?: Record<string, unknown>, label?: string }} IntegrationGrant */
/** @typedef {{ datatableId: string, mode: string, columns: string[], publicColumns: string[] }} TableGrant */
/** @typedef {{ agentId: string }} AgentGrant */
/** @typedef {{ viewersMayWrite: boolean }} DbGrant */
/** @typedef {{ ai: AiGrant, automations: AutomationGrant[], integrations: IntegrationGrant[], tables: TableGrant[], agent: AgentGrant | null, db: DbGrant }} BridgeGrants */

/** A stored value, before normalisation: anything JSON can hold. */
/** @typedef {Record<string, unknown>} RawRecord */

/**
 * @param {unknown} v
 * @returns {v is RawRecord}
 */
function isRecord(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** @type {BridgeGrants} */
const DEFAULT_BRIDGE_GRANTS = {
    // In-app defaults are permissive (author is authenticated). The `public*`
    // fields govern ANONYMOUS external-share viewers and default OFF — spending
    // the author's LLM budget for strangers must be opted into explicitly.
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
    // The page's own SQLite database. Every admitted reader shares it (the preview token acts as
    // the author there), but raw writes (`beeflowDB.exec` / `batch`) belong to the author alone
    // unless the author says that readers may write too. Default off.
    db: { viewersMayWrite: false },
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

/**
 * Column keys: only non-empty strings, de-duplicated, order preserved.
 * @param {unknown} raw
 */
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

/**
 * @param {unknown} raw
 * @returns {TableGrant | null}
 */
function normalizeTableGrant(raw) {
    if (!isRecord(raw)) return null;
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
        publicColumns: normalizeColumnKeys(raw.publicColumns).filter((c) => columns.includes(c)),
    };
}

/**
 * The Agent block: ONE agent, by id, or nothing.
 *
 * Deliberately WITHOUT a `public*` counterpart. ai.ask is deliberately kept out of the anonymous
 * bridge (services/publicShareBridge.js only knows /ai/chat and /ai/stream), so no shape should
 * exist here in which an author could set "public agent". A public agent bridge first requires
 * the A1 confirmation policy and then gets its own explicit field.
 * @param {unknown} raw
 * @returns {AgentGrant | null}
 */
function normalizeAgentGrant(raw) {
    if (!isRecord(raw)) return null;
    const agentId = typeof raw.agentId === 'string' ? raw.agentId.trim() : '';
    return agentId ? { agentId } : null;
}

/**
 * The page database: whether a reader admitted by audience may also write
 * through the exec/batch bridges. Only the literal true opens them; the author
 * always may.
 * @param {unknown} raw
 * @returns {DbGrant}
 */
function normalizeDbGrant(raw) {
    return { viewersMayWrite: isRecord(raw) && raw.viewersMayWrite === true };
}

/**
 * @param {unknown} raw
 * @returns {BridgeGrants}
 */
function normalizeBridgeGrants(raw) {
    /** @type {BridgeGrants} */
    const out = {
        ai: { ...DEFAULT_BRIDGE_GRANTS.ai },
        automations: [],
        integrations: [],
        tables: [],
        agent: null,
        db: normalizeDbGrant(null),
    };
    if (isRecord(raw)) {
        out.db = normalizeDbGrant(raw.db);
        if (isRecord(raw.ai)) {
            out.ai.enabled = raw.ai.enabled !== false;
            out.ai.groundOnPage = raw.ai.groundOnPage !== false;
            if (typeof raw.ai.defaultTier === 'string') out.ai.defaultTier = raw.ai.defaultTier;
            // Public-share (anonymous) AI — default OFF unless explicitly true.
            out.ai.publicEnabled = raw.ai.publicEnabled === true;
            out.ai.publicGroundOnPage = raw.ai.publicGroundOnPage === true;
            if (typeof raw.ai.publicDefaultTier === 'string') out.ai.publicDefaultTier = raw.ai.publicDefaultTier;
            const cap = parseFloat(String(raw.ai.publicSpendCapUsd));
            if (Number.isFinite(cap) && cap >= 0) {
                out.ai.publicSpendCapUsd = Math.min(cap, PUBLIC_AI_CAP_MAX);
            }
        }
        if (Array.isArray(raw.automations)) {
            out.automations = raw.automations
                .filter((e) => isRecord(e) && typeof e.automationId === 'string')
                .map((/** @type {RawRecord} */ e) => ({ automationId: String(e.automationId), ...(e.label ? { label: String(e.label) } : {}) }));
        }
        if (Array.isArray(raw.integrations)) {
            out.integrations = raw.integrations
                .filter((e) => isRecord(e) && typeof e.tool === 'string')
                .map((/** @type {RawRecord} */ e) => ({
                    tool: String(e.tool),
                    ...(isRecord(e.fixedArgs) ? { fixedArgs: e.fixedArgs } : {}),
                    ...(e.label ? { label: String(e.label) } : {}),
                }));
        }
        if (Array.isArray(raw.tables)) {
            // De-duplicated on datatableId. Two bindings for the same table make "which one applies?"
            // depend on whether a reader uses .find() or .filter() — and then sometimes the broader of
            // the two wins. The last entry wins, just like the atomic upsert below.
            /** @type {Map<string, TableGrant>} */
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

const GRANT_KINDS = /** @type {const} */ (['ai', 'automations', 'integrations', 'tables', 'agent', 'db']);

/**
 * Every kind the patch names replaces the current slice; the others stay.
 * @param {Record<string, unknown>} current
 * @param {Record<string, unknown> | null | undefined} patch
 */
function mergeGrantPatch(current, patch) {
    /** @type {Record<string, unknown>} */
    const merged = {};
    for (const kind of GRANT_KINDS) {
        merged[kind] = patch && patch[kind] !== undefined ? patch[kind] : current[kind];
    }
    return merged;
}

module.exports = { DEFAULT_BRIDGE_GRANTS, PUBLIC_AI_CAP_MAX, normalizeBridgeGrants, normalizeTableGrant, mergeGrantPatch };
