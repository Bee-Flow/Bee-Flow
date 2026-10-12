/**
 * DE GEDEELDE DATATABLE-RUNNER — "lees/schrijf deze tabel, als deze persoon,
 * en alleen deze kolommen".
 *
 * Er waren tot nu toe twee plekken die een datatable voor een principal
 * openden: `routes/datatables.js` (de Studio-UI, via `requireDatatableGrade` +
 * `metaAndFilter`) en `core/automationRunner/datatableResolve.js` (de runner).
 * Elke NIEUWE consument — de webpagina-brug hier, straks de datatable-tak van
 * App Studio (P3) — is een derde kopie van dezelfde twee beslissingen: in welke
 * tenant staat de tabel, en welke graad heeft deze persoon erop. Een kopie van
 * een autorisatiebeslissing is precies het soort code dat uit elkaar loopt
 * zonder dat iemand het merkt, dus die kopie komt er niet: dit is de ENE plek
 * die de compiler aanroept namens een consument.
 *
 * ── DRIE REGELS DIE HIER HARD STAAN ─────────────────────────────────
 *
 * 1. DE TENANT WORDT NOOIT GERADEN. De tabel wordt gezocht in de scopes die
 *    `datatableScopesFor(principal)` oplevert — de organisatie van de persoon
 *    en zijn eigen account, en nergens anders. Niet globaal zoeken en achteraf
 *    toetsen.
 *
 * 2. DE GRAAD WORDT ELKE KEER OPNIEUW BEREKEND uit de tabelrij plus zijn
 *    grants (`gradeForPrincipal`). Geen cache, geen doorgegeven graad: een
 *    grant die gisteren is ingetrokken moet vandaag stoppen te werken.
 *
 * 3. `allowColumns` IS VERPLICHT EN HEEFT GEEN "ALLES"-WAARDE. Elke lees- en
 *    schrijfaanroep noemt expliciet welke kolomsleutels de consument mag zien.
 *    De LEGE lijst betekent GEEN kolom (403), niet "alle" — dat is dezelfde
 *    afspraak die `normalizeBridgeGrants` op de opslagkant maakt, en wie hier
 *    `columns.length ? columns : ALLES` schrijft draait de versmalling in één
 *    regel om. Een ontbrekende `allowColumns` is een programmeerfout en gooit
 *    luid, want stil "alles" teruggeven is precies het lek dat deze parameter
 *    moet voorkomen.
 *
 * De kolomlijst begrenst ook FILTEREN en SORTEREN, niet alleen de projectie.
 * Anders kan een pagina op een kolom filteren die hij niet mag lezen en de
 * waarde er binair uit halen — een orakel is net zo goed een lek als een
 * kolom in de uitvoer. `search` (vrij zoeken over alle tekstkolommen) wordt om
 * dezelfde reden helemaal niet aangeboden.
 *
 * ── WAT HIER NIET IN ZIT ────────────────────────────────────────────
 * Alles wat over het VERZOEK gaat: authenticatie, rate limits, welke binding
 * er in `bridge_grants` staat, en of de lezer publiek of ingelogd is. Die
 * laatste is bewust geen parameter: een publieke lezer komt hier nooit langs
 * (zie services/webpageSnapshot.js — /w/<slug> is een statische snapshot), en
 * een vlag "publiek" zou uitnodigen hem ooit op false te zetten.
 *
 * LAAG: core/. Mag stores/ en auth/ gebruiken (platform), kent geen feature.
 */

'use strict';

const queryCompiler = require('./queryCompiler');
const accessFilter = require('./accessFilter');
const datatableStore = require('../../stores/datatableStore');
const datatableDbStore = require('../../stores/datatableDbStore');
const {
    gradeForPrincipal, gradeAtLeast, datatableScopesFor, synthesizeAccess,
} = require('../../auth/datatableAccess');

const PG = { dialect: 'pg' };

/** Bovengrens per pagina — dezelfde als `ROWS_PAGE_MAX` in routes/datatables.js. */
const ROWS_PAGE_MAX = 500;

/**
 * De velden die ALTIJD meekomen, náást de gebonden kolommen: de envelop
 * waarmee een rij te adresseren is. `id` om een rij te noemen, `updated_at`
 * omdat een wijziging zonder `expectedUpdatedAt` last-write-wins is.
 *
 * Bewust een allow-list en niet "systeemkolommen minus een paar": `created_by`
 * is een gebruikers-id en `org_id` een tenant — persoonsgegevens die een
 * pagina die één kolom mag lezen niet gratis moet krijgen. Een kolom die er
 * volgend jaar bij komt lekt zo niet vanzelf mee.
 */
const ROW_ENVELOPE = Object.freeze(['id', 'updated_at']);

/** Een weigering die de route letterlijk mag doorgeven: status + code + tekst. */
class DatatableRuntimeError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'DatatableRuntimeError';
        this.status = status;
        this.code = code;
        this.safe = true;
    }
}

function refuse(status, code, message) {
    return new DatatableRuntimeError(status, code, message);
}

/**
 * A write to a Solution stage's reference table: its rows are the release's
 * (queryCompiler RowsLockedError, 409 `managed_part`). The error goes through
 * UNCHANGED, only with the `safe` flag added, so the routes that pass only
 * `safe` refusals on verbatim (the webpage bridge) answer it as a 409 with its
 * code instead of a 500.
 */
function passLockedRows(e) {
    if (e instanceof queryCompiler.RowsLockedError) e.safe = true;
    return e;
}

/**
 * De kolomlijst van deze aanroep, gevalideerd.
 *
 * Geen array → programmeerfout (luid). Wel een array maar leeg → een echte,
 * uitlegbare weigering: de binding noemt geen enkele kolom.
 */
function requireAllowColumns(allowColumns) {
    if (!Array.isArray(allowColumns)) {
        throw new Error('datatableRuntime: allowColumns is required — there is no "all columns" value');
    }
    const clean = allowColumns.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim());
    if (!clean.length) {
        throw refuse(403, 'no_columns_bound',
            'This binding does not allow any column of that table');
    }
    return clean;
}

/**
 * Zoek de tabel in de scopes van deze principal en bepaal zijn graad.
 *
 * Geen graad → 404 (het bestaan van andermans tabel is niet af te tasten);
 * te lage graad → 403 (dan weet de beller al dat hij bestaat). Dezelfde
 * 404-vs-403-regel als routes/datatables.js.
 */
async function resolveForPrincipal(datatableId, principal, { needed = 'viewer' } = {}) {
    if (typeof datatableId !== 'string' || !datatableId) {
        throw refuse(400, 'datatable_required', 'A datatable id is required');
    }
    const scopes = datatableScopesFor(principal);
    if (!scopes.length) {
        // Geen org én geen account: er is niemand om als te lezen.
        throw refuse(404, 'datatable_not_found', 'Not found');
    }

    let table = null;
    let scope = null;
    for (const s of scopes) {
        table = await datatableStore.getDatatable(datatableId, s);
        if (table) { scope = s; break; }
    }
    if (!table) throw refuse(404, 'datatable_not_found', 'Not found');

    const grants = await datatableStore.listGrants(table.id);
    const grade = gradeForPrincipal(table, grants, principal);
    if (!grade) throw refuse(404, 'datatable_not_found', 'Not found');
    if (!gradeAtLeast(grade, needed)) {
        throw refuse(403, 'datatable_forbidden', `This needs ${needed} access to the datatable`);
    }

    const meta = await datatableStore.getTableMeta(scope, table.id);
    if (!meta) throw refuse(409, 'datatable_no_columns', 'This datatable has no columns yet');

    return {
        table,
        scope,
        scopeKey: datatableDbStore.scopeKey(scope),
        grade,
        principal,
        // De descriptor + het toegangsblok dat de compiler leest. Altijd samen:
        // compileAccessFilter zonder `access` zou op de default terugvallen.
        meta: { ...meta, access: synthesizeAccess(table) },
    };
}

/** Spiegelt deze tabel een externe bron? (core/dataEngine/sources) */
function isMirror(resolved) {
    return require('./sources').isSourceMirror(resolved?.table);
}

/** De write-through van de bron-soort van deze tabel. */
function mirrorWrites(resolved) {
    return require('./sources').writeThrough(resolved.table);
}

function mirrorCtx(resolved) {
    return mirrorWrites(resolved).contextOf({
        table: resolved.table, scope: resolved.scope, scopeKey: resolved.scopeKey,
        tableMeta: resolved.meta, grade: resolved.grade, viewerId: resolved.principal?.userId || null,
    });
}

/** De kolomsleutels die de tabel zelf declareert. */
function declaredKeys(resolved) {
    const fields = Array.isArray(resolved?.meta?.fields) ? resolved.meta.fields : [];
    return fields.map(f => f && f.key).filter(k => typeof k === 'string' && k);
}

/**
 * De doorsnede van "wat de binding toestaat" en "wat de tabel nog heeft".
 * Een kolom die de auteur inmiddels heeft weggegooid verdwijnt zo vanzelf,
 * zonder dat de aanroep kapotgaat.
 */
function effectiveColumns(resolved, allowColumns) {
    const declared = new Set(declaredKeys(resolved));
    return allowColumns.filter(c => declared.has(c));
}

/**
 * Knip één rij tot de envelop plus de toegestane kolommen.
 *
 * Opbouwen uit een allow-list, nooit sleutels uit de rij verwijderen: een
 * kolom die volgend jaar aan de tabel wordt toegevoegd hoort dan niet vanzelf
 * in het antwoord te staan.
 */
function projectRow(row, columns) {
    if (!row || typeof row !== 'object') return null;
    const out = {};
    for (const k of ROW_ENVELOPE) if (k in row) out[k] = row[k];
    for (const k of columns) if (k in row) out[k] = row[k];
    return out;
}

/** De sorteervelden van een descriptor, in beide vormen die de compiler kent. */
function sortFields(sort) {
    if (Array.isArray(sort)) return sort.map(s => s && s.field);
    if (sort && typeof sort === 'object') return [sort.field];
    return [];
}

/** Elk veld waarop gefilterd of gesorteerd wordt moet gebonden zijn. */
function assertFieldsBound(fields, columns) {
    const allowed = new Set(columns);
    for (const f of fields) {
        if (typeof f !== 'string' || !f) continue;
        if (!allowed.has(f)) {
            throw refuse(400, 'column_not_bound',
                `This page may not use the column "${f}" of that table`);
        }
    }
}

/**
 * Een pagina rijen, keyset-gepagineerd, geprojecteerd op de gebonden kolommen.
 *
 * De projectie gebeurt NA de query: de compiler kent geen SELECT-lijst
 * (`SELECT *`), dus de databank levert de hele rij en deze functie is de plek
 * waar besloten wordt wat de server verlaat. Dat is geen excuus om hem over te
 * slaan — het is juist de reden dat hij hier staat en niet in een route.
 */
async function readRows(resolved, { allowColumns, filters, match, sort, limit, cursor } = {}) {
    // Een spiegel van een externe bron wordt op de achtergrond ververst
    // zodra iemand ernaar kijkt en de kopie ouder is dan zijn schema
    // (core/dataEngine/sources). Nooit van invloed op deze lezing.
    if (isMirror(resolved)) {
        try {
            require('./sources').kickStale(resolved.table, { reason: 'view' });
        } catch (_) { /* never a reason to fail a read */ }
    }
    const columns = effectiveColumns(resolved, requireAllowColumns(allowColumns));
    if (!columns.length) {
        // De binding noemt alleen kolommen die niet (meer) bestaan.
        throw refuse(403, 'no_columns_bound', 'This binding does not allow any column of that table');
    }
    const filterList = Array.isArray(filters) ? filters : [];
    assertFieldsBound(filterList.map(f => f && f.field), columns);
    // `sort` mag een object OF een lijst zijn — resolvePrimarySort accepteert
    // allebei en pakt bij een lijst de eerste. Alleen `sort.field` toetsen liet
    // `sort: [{field:'geheim'}]` er dus ongezien langs, en dat is precies het
    // orakel dat deze toets moet dichthouden.
    assertFieldsBound(sortFields(sort), columns);

    await require('../../stores/lib/sheetCrypto').assertQuery(resolved, [...filterList.map(f => f?.field), ...sortFields(sort)]);

    const filter = accessFilter.compileAccessFilter(
        resolved.meta, resolved.grade, { id: resolved.principal?.userId || null }, 'read', PG);
    const compiled = queryCompiler.compileRecordList(resolved.meta, {
        filters: filterList,
        match: match || 'all',
        sort: sort || null,
        limit, maxLimit: ROWS_PAGE_MAX,
        cursor: cursor || null,
        dialect: 'pg',
    }, filter);

    const out = await datatableDbStore.query(
        resolved.scopeKey, resolved.scopeKey, compiled.sql, compiled.params);
    // LET OP bij het lezen van `nextCursor` hieronder: die codeert de waarde van
    // het primaire sorteerveld van de laatste rij, en dat is bij de standaard
    // sortering `created_at` — een systeemkolom die NIET in de projectie zit.
    // De cursor is base64, niet versleuteld, dus een pagina kan die datum
    // uitlezen. Aanvaard omdat de lezer sowieso viewer-graad op de hele tabel
    // heeft; wie dat te ruim vindt, moet de cursor ondertekenen of de default
    // sortering op een gebonden kolom zetten — niet de cursor stilletjes
    // weglaten, want dan is pagina 2 onbereikbaar.
    const sheetCrypto = require('../../stores/lib/sheetCrypto');
    const all = sheetCrypto.isSheet(resolved) ? await sheetCrypto.openRows(resolved.table.id, out?.rows || []) : (out?.rows || []);
    // compileRecordList vraagt bewust limit+1 op als cursorsonde; die extra rij
    // hoort er nooit uit te komen.
    const page = all.slice(0, compiled.limit);
    const hasMore = all.length > compiled.limit;
    const last = page[page.length - 1];
    return {
        rows: page.map(r => projectRow(r, columns)),
        hasMore,
        count: page.length,
        nextCursor: (hasMore && last)
            ? queryCompiler.encodeCursor(last[compiled.primaryField], last.id)
            : null,
        columns,
    };
}

/**
 * Groepeer en tel — en daarmee: "welke waarden komen in deze kolom voor".
 *
 * Er was tot nu toe geen manier om dat namens een principal te vragen zonder
 * de hele tabel te lezen. `compileAggregate` kan het al (GROUP BY zonder
 * aggregaten geeft precies de distinct-waarden); wat ontbrak was deze plek,
 * met DEZELFDE begrenzing als `readRows`: de kolomlijst bindt ook wat je mag
 * groeperen en tellen. Anders is "groepeer op de kolom die ik niet mag lezen"
 * hetzelfde orakel dat `assertFieldsBound` bij filteren en sorteren dichthoudt.
 *
 * De toegangsfilter gaat in de WHERE, vóór de GROUP BY (invariant van de
 * compiler) — een rij die deze persoon niet mag zien telt dus ook niet mee.
 */
async function aggregateRows(resolved, { allowColumns, groupBy, aggregates, filters, match, sort, limit } = {}) {
    const columns = effectiveColumns(resolved, requireAllowColumns(allowColumns));
    if (!columns.length) {
        throw refuse(403, 'no_columns_bound', 'This binding does not allow any column of that table');
    }
    const groups = Array.isArray(groupBy) ? groupBy : [];
    const aggs = Array.isArray(aggregates) ? aggregates : [];
    const filterList = Array.isArray(filters) ? filters : [];
    assertFieldsBound(groups.map(g => g && g.field), columns);
    // `count(*)` heeft geen veld; alleen een echte kolomnaam wordt getoetst.
    assertFieldsBound(aggs.map(a => (a && a.field !== '*' ? a && a.field : null)), columns);
    assertFieldsBound(filterList.map(f => f && f.field), columns);
    assertFieldsBound(sortFields(sort), columns);

    await require('../../stores/lib/sheetCrypto').assertQuery(resolved, [...groups.map(g => g?.field), ...aggs.map(a => a?.field), ...filterList.map(f => f?.field), ...sortFields(sort)]);

    const filter = accessFilter.compileAccessFilter(
        resolved.meta, resolved.grade, { id: resolved.principal?.userId || null }, 'read', PG);
    const compiled = queryCompiler.compileAggregate(resolved.meta, {
        filters: filterList,
        match: match || 'all',
        groupBy: groups,
        aggregates: aggs,
        sort: sort || null,
        limit,
        dialect: 'pg',
    }, filter);
    const out = await datatableDbStore.query(
        resolved.scopeKey, resolved.scopeKey, compiled.sql, compiled.params);
    return { rows: out?.rows || [] };
}

/**
 * De waarden van een schrijfactie, getoetst aan de binding.
 *
 * Een niet-gebonden kolom wordt GEWEIGERD, niet stil weggelaten: een pagina die
 * denkt dat ze een veld heeft opgeslagen terwijl dat niet zo is, is erger dan
 * een pagina die een foutmelding krijgt.
 */
function assertValuesBound(values, columns) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw refuse(400, 'no_values', 'Say which columns to write');
    }
    const keys = Object.keys(values);
    if (!keys.length) throw refuse(400, 'no_values', 'Say which columns to write');
    assertFieldsBound(keys, columns);
    return values;
}

/** Eén rij toevoegen. Vereist graad `editor` én create-recht op de descriptor. */
async function insertRow(resolved, { allowColumns, values } = {}) {
    const columns = effectiveColumns(resolved, requireAllowColumns(allowColumns));
    const clean = await require('../../stores/lib/sheetCrypto').sealValues(resolved, assertValuesBound(values, columns));
    accessFilter.assertCanWrite(resolved.meta, resolved.grade, 'create');
    // Een spiegel: de rij gaat éérst naar Nextcloud, de kopie volgt uit wat
    // Nextcloud antwoordde. Dezelfde weigeringen (status/code/safe) als hier.
    if (isMirror(resolved)) {
        const r = await mirrorWrites(resolved).insertRow(mirrorCtx(resolved), clean);
        return { id: r.id };
    }
    let compiled;
    try {
        compiled = queryCompiler.compileInsert(resolved.meta, clean, {
            createdBy: resolved.principal?.userId || null,
            // NULL op een persoonlijke tabel, en dat klopt: die rij hoort bij geen
            // organisatie. Hier ctx-org invullen zou de rij gedeeld laten lijken.
            orgId: resolved.table.organizationId,
            dialect: 'pg',
        });
    } catch (e) { throw passLockedRows(e); }
    const { sql, params, id } = compiled;
    await datatableDbStore.exec(resolved.scopeKey, resolved.scopeKey, sql, params);
    await datatableStore.bumpAfterWrite(resolved.table.id, resolved.scope, 1);
    return { id };
}

/**
 * Eén rij wijzigen, met optimistisch slot.
 *
 * `expectedUpdatedAt` is verplicht, net als in routes/datatables.js: elke lezing
 * levert `updated_at` mee, dus een schrijver kán hem hebben, en zonder hem is
 * elke wijziging last-write-wins tussen twee bezoekers van dezelfde pagina.
 */
async function updateRow(resolved, { allowColumns, rowId, values, expectedUpdatedAt } = {}) {
    const columns = effectiveColumns(resolved, requireAllowColumns(allowColumns));
    if (typeof rowId !== 'string' || !rowId) {
        throw refuse(400, 'row_required', 'A row id is required');
    }
    if (typeof expectedUpdatedAt !== 'string' || !expectedUpdatedAt) {
        throw refuse(400, 'expected_updated_at_required',
            'Send the updated_at you read, so a colleague\'s edit is not silently overwritten');
    }
    const clean = await require('../../stores/lib/sheetCrypto').sealValues(resolved, assertValuesBound(values, columns), rowId);
    accessFilter.assertCanWrite(resolved.meta, resolved.grade, 'update');

    if (isMirror(resolved)) {
        const r = await mirrorWrites(resolved).updateRow(mirrorCtx(resolved), rowId, clean, { expectedUpdatedAt });
        if (!r.changes) {
            if (!r.row) throw refuse(404, 'row_not_found', 'Not found');
            const conflict = refuse(409, 'row_conflict', 'Someone else changed this row while you had it open');
            conflict.row = projectRow(r.row, columns);
            throw conflict;
        }
        return { row: projectRow(r.row, columns) };
    }

    const filter = accessFilter.compileAccessFilter(
        resolved.meta, resolved.grade, { id: resolved.principal?.userId || null }, 'update', PG);
    let upd;
    try {
        upd = queryCompiler.compileUpdate(resolved.meta, rowId, clean, filter,
            { expectedUpdatedAt, dialect: 'pg' });
    } catch (e) { throw passLockedRows(e); }
    const out = await datatableDbStore.exec(resolved.scopeKey, resolved.scopeKey, upd.sql, upd.params);

    // Altijd teruglezen: bij succes heeft de beller de nieuwe `updated_at` nodig
    // voor zijn VOLGENDE wijziging, en bij mislukking is de rij zelf het verschil
    // tussen "iemand anders was je voor" en "hij bestaat niet (meer) voor jou".
    const probe = queryCompiler.compileGetById(resolved.meta, rowId, filter, PG);
    const found = await datatableDbStore.query(resolved.scopeKey, resolved.scopeKey, probe.sql, probe.params);
    const rawRow = (found?.rows || [])[0] || null;
    const sheetCrypto = require('../../stores/lib/sheetCrypto');
    const row = sheetCrypto.isSheet(resolved) ? await sheetCrypto.openRow(resolved.table.id, rawRow) : rawRow;

    if (!out?.changes) {
        if (!row) throw refuse(404, 'row_not_found', 'Not found');
        const conflict = refuse(409, 'row_conflict', 'Someone else changed this row while you had it open');
        conflict.row = projectRow(row, columns);
        throw conflict;
    }
    await datatableStore.bumpAfterWrite(resolved.table.id, resolved.scope, 0);
    return { row: projectRow(row, columns) };
}

module.exports = {
    DatatableRuntimeError,
    ROW_ENVELOPE,
    ROWS_PAGE_MAX,
    resolveForPrincipal,
    readRows,
    aggregateRows,
    insertRow: (resolved, args) => require('../../stores/lib/sheetCrypto').withWrite(resolved, () => insertRow(resolved, args)),
    updateRow: (resolved, args) => require('../../stores/lib/sheetCrypto').withWrite(resolved, () => updateRow(resolved, args)),
    projectRow,
    // test-only
    _effectiveColumns: effectiveColumns,
};
