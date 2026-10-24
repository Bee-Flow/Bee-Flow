/**
 * The middle column of "Data & connections": what hangs on this page?
 *
 * Four kinds of cards, three of which come from here:
 *   TABLE        per bound datatable — name, rows, column chips, and whether
 *                the page mentions it in its own code ("not used").
 *   AUTOMATION   per automation that FEEDS such a bound table — derived from the
 *                usage index (`automation_datatable_usage`), not from a
 *                second list that someone has to maintain: which columns it
 *                touches, in which mode, and when it last ran.
 *   WARNING      an automation that writes DIRECTLY into a bound table.
 *                That is not an error message but a notice: whoever edits the page
 *                must know that another process also sits on those rows, with a deep link to
 *                the detail screen of that table.
 * The fourth card (Knowledge sources, the webpage_auto KB) is drawn by the client from `sources`,
 * which the Data tab already has — no server round trip is needed for that.
 *
 * ── THREE THINGS THAT MUST NOT SHIFT HERE ───────────────────────────
 *
 * 1. THIS READS AS THE OWNER, and the route is owner-only. It is a management screen over
 *    his own bindings; an org reader of the page has nothing to do here and would
 *    learn through the column lists what is in someone else's table.
 *
 * 2. "NOT USED" IS AN ASSERTION, and it is only made if it could be checked. `usedInCode`
 *    is therefore THREE-VALUED: true / false / null.
 *    null = the files were not readable. The UI may then show neither of the two labels —
 *    "empty" and "unreadable" must remain different.
 *
 * 3. A TABLE THAT THE OWNER MAY NO (LONGER) READ becomes `missing`, not omitted.
 *    Silently disappearing lets the author think that the binding is gone, while it
 *    still stands and can work again tomorrow.
 */

'use strict';

const bridgeGrants = require('../../stores/webpage/bridgeGrants');
const datatableAccess = require('../../auth/datatableAccess');
const datatableRuntime = require('../../core/dataEngine/datatableRuntime');
const datatableStore = require('../../stores/datatableStore');
const webpageBindings = require('./webpageBindings');

/** Modi uit de usage-index die de tabel VERANDEREN. */
const WRITING_MODES = new Set(['write', 'readwrite']);

/**
 * Does the page's own code mention this table?
 *
 * A rough text search on the table id in ALL own text files of the
 * page — the three slots and the extras, because a react-mui page has its
 * whole app under `src/` and would otherwise have every bound table stamped as "not
 * used". That is precisely what can be known without the
 * parser that W4 builds, and it is
 * honest about its limit: a `<bf-table source="tbl_x">` and a
 * `beeflowTables.query("tbl_x")` are both found, an id that comes from a
 * variable is not. That is why "not found" in the UI is a soft, dotted notice
 * and not an error.
 *
 * @returns {Map<string, boolean>|null} null if the files were not readable
 */
async function scanCodeForTables(userId, webpageId, datatableIds) {
    if (!datatableIds.length) return new Map();
    // Via webpageBindings.readPageCode, NOT directly via readAllSlots: that
    // gives empty strings back as soon as the object storage is down, and that would here
    // be read as "the page does not mention the table". The readability flag
    // keeps unreadable and empty apart.
    const code = await webpageBindings.readPageCode(userId, webpageId);
    if (!code.readable) return null;          // onleesbaar ≠ niet gebruikt
    const haystack = [code.html, code.js, ...(code.extras || []).map(f => f.text)].join('\n');
    const out = new Map();
    for (const id of datatableIds) out.set(id, haystack.includes(id));
    return out;
}

/** Eén rij per automatisering: de ruimste modus wint, de kolommen worden samengevoegd. */
function foldAutomations(usageRows, { datatableId, tableName }) {
    const byId = new Map();
    for (const u of usageRows) {
        if (!u || u.consumerKind !== 'automation' || !u.automationId) continue;
        const prev = byId.get(u.automationId);
        const columns = new Set([...(prev?.columns || []), ...(Array.isArray(u.columns) ? u.columns : [])]);
        const writes = (prev?.writes === true) || WRITING_MODES.has(u.mode);
        // The last run belongs to the AUTOMATION, not to the step; they are equal per
        // row, but a null in one row may not wipe a date in the other.
        const lastRunAt = prev?.lastRunAt || u.lastRunAt || null;
        byId.set(u.automationId, {
            automationId: u.automationId,
            title: u.automationTitle || prev?.title || null,
            datatableId,
            tableName,
            columns: [...columns],
            writes,
            lastRunAt,
        });
    }
    return [...byId.values()];
}

/**
 * Bouw het kaartenmodel voor één pagina.
 *
 * @param {object} args
 * @param {string} args.webpageId
 * @param {string} args.userId   de EIGENAAR (de route is eigenaar-only)
 */
async function buildDataCards({ webpageId, userId }) {
    const grants = await bridgeGrants.getBridgeGrants(webpageId);
    const bindings = Array.isArray(grants.tables) ? grants.tables : [];

    const usedInCode = await scanCodeForTables(userId, webpageId, bindings.map(b => b.datatableId));
    const principal = await datatableAccess.resolveDatatablePrincipalForUser(userId);

    const tables = [];
    const automations = [];
    const warnings = [];

    for (const binding of bindings) {
        const base = {
            datatableId: binding.datatableId,
            mode: binding.mode,
            columns: binding.columns,
            publicColumns: binding.publicColumns,
            // Drie waarden, niet twee: null = niet vast te stellen.
            usedInCode: usedInCode ? (usedInCode.get(binding.datatableId) ?? false) : null,
        };

        let resolved = null;
        try {
            resolved = await datatableRuntime.resolveForPrincipal(binding.datatableId, principal, { needed: 'viewer' });
        } catch (err) {
            tables.push({
                ...base,
                missing: true,
                // Only the code, not the text of the error: this goes to a
                // screen, not to a log.
                reason: (err && err.safe === true && err.code) ? err.code : 'unavailable',
                name: null, key: null, rowCount: null, allColumns: [],
            });
            continue;
        }

        const allColumns = (Array.isArray(resolved.meta?.fields) ? resolved.meta.fields : [])
            .map(f => ({ key: f.key, label: f.label || f.name || f.key }))
            .filter(c => c.key);

        tables.push({
            ...base,
            missing: false,
            reason: null,
            name: resolved.table.name || null,
            key: resolved.table.key || null,
            // Bij benadering tussen retentie-vegen door — de UI zegt dat erbij.
            rowCount: Number.isFinite(resolved.table.rowCount) ? resolved.table.rowCount : null,
            allColumns,
            grade: resolved.grade,
        });

        let usage = [];
        try { usage = await datatableStore.listUsage(binding.datatableId); }
        catch { usage = []; }
        for (const a of foldAutomations(usage, { datatableId: binding.datatableId, tableName: resolved.table.name || null })) {
            automations.push(a);
            if (a.writes) {
                warnings.push({
                    kind: 'automation_writes_directly',
                    automationId: a.automationId,
                    automationTitle: a.title,
                    datatableId: binding.datatableId,
                    tableName: resolved.table.name || null,
                });
            }
        }
    }

    return {
        tables,
        automations,
        warnings,
        // What the tab badge "n" counts. The Knowledge sources card counts too, but
        // that one knows only the client (from `sources`), so it is added there.
        counts: { tables: tables.length, automations: automations.length },
    };
}

module.exports = { buildDataCards, foldAutomations, scanCodeForTables };
