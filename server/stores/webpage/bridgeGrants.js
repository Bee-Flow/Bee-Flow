// @typecheck
// Runtime bridge grants: the `bridge_grants` column that says what a page's
// script.js may invoke via window.beeflowAI / beeflowAutomations /
// beeflowIntegrations — the normalizer, the whole-column read/write, and the
// atomic single-entry grant/revoke statements.

const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { parseJSON } = require('./shared');

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
    // W3: tabelbindingen (window.beeflowTables) en het Agent-blok. Allebei
    // beginnen op "niets": geen tabel gebonden, geen agent gekozen. Zolang een
    // sleutel hier NIET staat, gooit normalizeBridgeGrants hem stil weg — de
    // kolom wordt bij elke lees- en schrijfbeurt uit deze vaste vorm herbouwd.
    tables: [],
    agent: null,
};

// ── tabelbindingen ────────────────────────────────────────────────────
//
// Eén binding = één datatable die de pagina via window.beeflowTables mag lezen
// (en met mode 'readwrite' mag schrijven). `publicColumns` is een APARTE, altijd
// smallere poort: de snapshot-writer rendert bf-table server-side uit precies
// die lijst, dus een kolom die er niet in staat verlaat /w/<slug> nooit.
//
// Elke onleesbare waarde VERSMALT, nooit andersom:
//   - een mode die niet letterlijk 'readwrite' is, wordt 'read';
//   - onleesbare `columns` worden de LEGE lijst — en leeg betekent hier GEEN
//     kolom, niet "alle". Er bestaat met opzet geen waarde die "alles" zegt;
//   - `publicColumns` wordt geknipt tot een deelverzameling van `columns`.
const TABLE_WRITE_MODE = 'readwrite';

/** Kolomsleutels: alleen niet-lege strings, ontdubbeld, volgorde behouden. */
function normalizeColumnKeys(raw) {
    if (!Array.isArray(raw)) return [];
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
        // Alleen de letterlijke string 'readwrite' verbreedt: 'write', 'RW',
        // true, 1, undefined en een ontbrekend veld zijn allemaal 'read'.
        mode: raw.mode === TABLE_WRITE_MODE ? TABLE_WRITE_MODE : 'read',
        columns,
        // Nooit ruimer dan de binding zelf. Een kolom die de pagina intern niet
        // eens leest kan niet publiek zijn; met `columns` leeg is deze lijst
        // dus per definitie ook leeg.
        publicColumns: normalizeColumnKeys(raw.publicColumns).filter(c => columns.includes(c)),
    };
}

/**
 * Het Agent-blok: ÉÉN agent, op id, of niets.
 *
 * Bewust ZONDER `public*`-tegenhanger. ai.ask is met opzet uit de anonieme
 * bridge gehouden (services/publicShareBridge.js kent alleen /ai/chat en
 * /ai/stream), dus er hoort hier geen vorm te bestaan waarin een auteur
 * "publieke agent" aan kan zetten. Een publieke agent-bridge vereist eerst het
 * A1-bevestigingsbeleid en krijgt dán zijn eigen expliciete veld.
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
            // Ontdubbeld op datatableId. Twee bindingen voor dezelfde tabel
            // maken "welke geldt?" afhankelijk van of een lezer .find() of
            // .filter() gebruikt — en dan wint soms de ruimste van de twee.
            // De laatste entry wint, net als de atomaire upsert hieronder.
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

async function getBridgeGrants(webpageId) {
    await initDB();
    const r = await getOne('SELECT bridge_grants FROM webpages WHERE id = $1', [webpageId]);
    return normalizeBridgeGrants(r ? parseJSON(r.bridge_grants, null) : null);
}

/**
 * Owner-only write. `patch` is a partial — any kind (`ai` / `automations` /
 * `integrations` / `tables` / `agent`) you supply replaces the corresponding
 * slice wholesale. To incrementally add/remove a single grant, read first,
 * mutate, write.
 *
 * `agent: null` is een geldige waarde (wis de agent); alleen `undefined` laat
 * de huidige staan. Vandaar overal de !== undefined-toets.
 */
async function updateBridgeGrants(webpageId, userId, patch) {
    await initDB();
    const current = await getBridgeGrants(webpageId);
    const merged = normalizeBridgeGrants({
        ai: patch?.ai !== undefined ? patch.ai : current.ai,
        automations: patch?.automations !== undefined ? patch.automations : current.automations,
        integrations: patch?.integrations !== undefined ? patch.integrations : current.integrations,
        tables: patch?.tables !== undefined ? patch.tables : current.tables,
        agent: patch?.agent !== undefined ? patch.agent : current.agent,
    });
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
const GRANT_LISTS = {
    integrations: 'tool',
    automations: 'automationId',
    // Tabelbindingen lopen langs dezelfde atomaire weg: de Data-tab schakelt ze
    // per tabel aan/uit, en twee gelijktijdige schakelaars mogen elkaar net zo
    // min verliezen als de tool-grants dat mochten.
    tables: 'datatableId',
};

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
 * Add (or replace) one entry in a bridge-grant list, atomically.
 * @returns the full normalized grants after the write, or null when the page
 *          does not exist / is not owned by `userId`.
 */
async function upsertBridgeGrantEntry(webpageId, userId, list, entry) {
    if (!GRANT_LISTS[list]) throw new Error(`upsertBridgeGrantEntry: unknown list "${list}"`);
    await initDB();
    const idKey = GRANT_LISTS[list];
    const id = entry && entry[idKey];
    if (typeof id !== 'string' || !id) throw new Error(`upsertBridgeGrantEntry: entry.${idKey} is required`);
    // Normalize the single entry through the shared normalizer so the shape
    // written here can never drift from the whole-column path.
    const [clean] = normalizeBridgeGrants({ [list]: [entry] })[list];
    if (!clean) throw new Error(`upsertBridgeGrantEntry: invalid ${list} entry`);
    const r = await getOne(_grantListSql(list, true), [webpageId, userId, id, JSON.stringify(clean)]);
    if (!r) return null;
    return normalizeBridgeGrants(parseJSON(r.bridge_grants, null));
}

/**
 * Remove one entry from a bridge-grant list, atomically. Same return contract
 * as upsertBridgeGrantEntry; removing something absent is a no-op success.
 */
async function removeBridgeGrantEntry(webpageId, userId, list, id) {
    if (!GRANT_LISTS[list]) throw new Error(`removeBridgeGrantEntry: unknown list "${list}"`);
    await initDB();
    if (typeof id !== 'string' || !id) throw new Error('removeBridgeGrantEntry: id is required');
    const r = await getOne(_grantListSql(list, false), [webpageId, userId, id]);
    if (!r) return null;
    return normalizeBridgeGrants(parseJSON(r.bridge_grants, null));
}

/**
 * Check whether `kind` (`ai` / `automation` / `integration`) for `key` is
 * granted on this webpage. Returns the grant entry (or `true` for ai) when
 * allowed, `null` when not.
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
 * Welke pagina's zijn aan DEZE tabel gebonden — en houden er een publiek adres
 * op na?
 *
 * De omgekeerde weg van alle andere lezingen hier: niet "wat mag deze pagina",
 * maar "wie hangt er aan deze tabel". De W5-reconciler gebruikt hem om na een
 * rij-mutatie elke openbare snapshot te vernieuwen — zie
 * core/webpages/webpageShareReconciler.js voor waarom dat een AVG-pad is.
 *
 * Twee dingen die de vorm van deze query bepalen:
 *
 *  1. `@>` op JSONB, niet een LIKE op de tekst. Een tabel-id komt óók voor in
 *     `columns` of in een label, en een tekstmatch zou pagina's oplepelen die
 *     helemaal niet aan deze tabel gebonden zijn.
 *  2. `public_share_id IS NOT NULL`. Een pagina zonder publiek adres heeft geen
 *     snapshot om te vernieuwen. Dit filter staat in de DATABASE en niet in de
 *     aanroeper, zodat een lus over duizend gebonden pagina's er geen duizend
 *     wordt als er maar drie openbaar zijn.
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
    listPublicWebpagesBoundToDatatable,
    normalizeBridgeGrants,
    getBridgeGrants,
    updateBridgeGrants,
    upsertBridgeGrantEntry,
    removeBridgeGrantEntry,
    checkGrant,
};
