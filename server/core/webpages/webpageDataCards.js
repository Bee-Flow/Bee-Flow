/**
 * De middenkolom van "Data & koppelingen": wat hangt er aan deze pagina?
 *
 * Vier soorten kaarten, drie ervan komen hiervandaan:
 *   TABEL        per gebonden datatable — naam, rijen, kolomchips, en of de
 *                pagina hem in haar eigen code noemt ("niet gebruikt").
 *   AUTOMATION   per routine die zo'n gebonden tabel VOEDT — afgeleid uit de
 *                usage-index (`automation_datatable_usage`), niet uit een
 *                tweede lijst die iemand moet bijhouden: welke kolommen hij
 *                aanraakt, in welke modus, en wanneer hij voor het laatst liep.
 *   WAARSCHUWING een routine die RECHTSTREEKS in een gebonden tabel schrijft.
 *                Dat is geen foutmelding maar een mededeling: wie de pagina
 *                bewerkt moet weten dat er ook een ander proces aan die rijen
 *                zit, met een deeplink naar het deelscherm van die tabel.
 * De vierde kaart (Kennisbronnen, de webpage_auto-KB) tekent de client uit
 * `sources`, die de Data-tab toch al heeft — daar is geen serverronde voor nodig.
 *
 * ── DRIE DINGEN DIE HIER NIET MOGEN VERSCHUIVEN ─────────────────────
 *
 * 1. DIT LEEST ALS DE EIGENAAR, en de route is eigenaar-only. Het is een
 *    beheerscherm over zijn eigen bindingen; een org-lezer van de pagina heeft
 *    hier niets te zoeken en zou via de kolomlijsten leren wat er in andermans
 *    tabel staat.
 *
 * 2. "NIET GEBRUIKT" IS EEN BEWERING, en die wordt alleen gedaan als hij te
 *    controleren was. `usedInCode` is daarom DRIEWAARDIG: true / false / null.
 *    null = de bestanden waren niet te lezen. De UI mag dan geen van beide
 *    labels tonen — "leeg" en "onleesbaar" moeten verschillend blijven.
 *
 * 3. EEN TABEL DIE DE EIGENAAR NIET (MEER) MAG LEZEN wordt `missing`, niet
 *    weggelaten. Stil verdwijnen laat de auteur denken dat de binding weg is,
 *    terwijl die er nog staat en morgen weer kan werken.
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
 * Noemt de eigen code van de pagina deze tabel?
 *
 * Een grove tekstzoektocht op het tabel-id in ALLE eigen tekstbestanden van de
 * pagina — de drie slots én de extra's, want een react-mui-pagina heeft haar
 * hele app onder `src/` staan en zou anders elke gebonden tabel als "niet
 * gebruikt" gestempeld krijgen. Dat is precies wat er te weten valt zonder de
 * parser die W4 bouwt, en het is
 * eerlijk over zijn grens: een `<bf-table source="tbl_x">` en een
 * `beeflowTables.query("tbl_x")` worden allebei gevonden, een id dat uit een
 * variabele komt niet. Vandaar dat "niet gevonden" in de UI een zachte,
 * gestippelde mededeling is en geen fout.
 *
 * @returns {Map<string, boolean>|null} null als de bestanden niet leesbaar waren
 */
async function scanCodeForTables(userId, webpageId, datatableIds) {
    if (!datatableIds.length) return new Map();
    // Via webpageBindings.readPageCode, NIET rechtstreeks via readAllSlots: die
    // geeft lege strings terug zodra de objectopslag plat ligt, en dat zou hier
    // als "de pagina noemt de tabel niet" worden gelezen. De leesbaarheidsvlag
    // houdt onleesbaar en leeg uit elkaar.
    const code = await webpageBindings.readPageCode(userId, webpageId);
    if (!code.readable) return null;          // onleesbaar ≠ niet gebruikt
    const haystack = [code.html, code.js, ...(code.extras || []).map(f => f.text)].join('\n');
    const out = new Map();
    for (const id of datatableIds) out.set(id, haystack.includes(id));
    return out;
}

/** Eén rij per routine: de ruimste modus wint, de kolommen worden samengevoegd. */
function foldAutomations(usageRows, { datatableId, tableName }) {
    const byId = new Map();
    for (const u of usageRows) {
        if (!u || u.consumerKind !== 'automation' || !u.automationId) continue;
        const prev = byId.get(u.automationId);
        const columns = new Set([...(prev?.columns || []), ...(Array.isArray(u.columns) ? u.columns : [])]);
        const writes = (prev?.writes === true) || WRITING_MODES.has(u.mode);
        // De laatste run hoort bij de ROUTINE, niet bij de stap; ze zijn per
        // rij gelijk, maar een null in de ene rij mag een datum in de andere
        // niet wissen.
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
                // Alleen de code, niet de tekst van de fout: dit gaat naar een
                // scherm, niet naar een log.
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
        // Wat de tab-badge "n" telt. De Kennisbronnen-kaart telt ook mee, maar
        // die kent alleen de client (uit `sources`), dus die wordt daar opgeteld.
        counts: { tables: tables.length, automations: automations.length },
    };
}

module.exports = { buildDataCards, foldAutomations, scanCodeForTables };
