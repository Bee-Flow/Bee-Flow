/**
 * App Studio action executor — RECORD WRITES (extracted verbatim from
 * actionExecutor.js): the writeRecord / writeRecordBatch choke point, the
 * create_record / update_record / delete_record steps and the best-effort
 * data-version + row-count bookkeeping that follows every write.
 *
 * ── TWEE TABELSOORTEN, TWEE OPSLAGEN ────────────────────────────────
 *
 * Een modeltabel ZONDER `source` bezit haar eigen opslag: dat is `writeRecord`
 * hieronder, met `studioAppDbStore` (de eigenaar-gescoopte per-app-engine) en de
 * per-app quota. Een modeltabel MÉT
 * `source = {kind:'datatable', datatableId, mode}` haalt haar rijen uit een
 * Studio-datatabel, buiten de app: dan gaat het naar het datatabel-pad onderaan
 * dit bestand — `datatableDbStore` op de scope-sleutel en de datatabel-quota.
 *
 * DE SPLITSING STAAT OP HET KNOOPPUNT ZELF, niet alleen in de drie
 * stap-handlers. Dat was hier eerst wél zo, en het maakte van het knooppunt het
 * tweede schrijfpad dat de kop hieronder juist uitsluit: `writeRecord` en
 * `writeRecordBatch` schreven een gekoppelde tabel onvoorwaardelijk naar de
 * app-eigen opslag. Alles wat NIET via create_record/update_record/delete_record
 * binnenkomt liep daar langs — de record-API (POST/PATCH/DELETE
 * /:id/data/tables/:tableId/records), ai_extract writeTo, file_intake,
 * dataset_query, de send_email-logrij, de goedkeuringshaak, connectorSync en
 * templateInstall — met drie gevolgen tegelijk: een `mode:'read'`-koppeling was
 * beschrijfbaar, de graad van de kijker werd nooit opgezocht, en de rij landde
 * in een schaduwtabel die het LEESpad (dataReadRunner.readPlan → de datatabel)
 * nooit bevraagt. `success:true`, en de rij daarna nergens te zien.
 *
 * Vandaar: `writeRecord`, `writeRecordBatch` en `eraseRecord` vertakken zelf, en
 * de stap-handlers zijn niets meer dan de bindingen eromheen. Eén tak per
 * knooppunt, geen enkele aanroeper met een eigen kopie.
 *
 * WIE ER MAG SCHRIJVEN wordt hier niet beslist. Die vraag staat in
 * `appStudio/datatableSource.js`, samen met het antwoord voor het LEESpad
 * (dataReadRunner): één body, twee ingangen. Twee implementaties van "welke
 * graad geldt door deze deur" lopen uit elkaar, en de kopie die drift is altijd
 * de kopie waar niemand naar kijkt. Wat hier overblijft is compileren en
 * uitvoeren.
 *
 * De twee opslagen delen niets en mogen dus nooit in elkaars pad vallen: een
 * `source` die niet gelezen kan worden is een FOUT en geen terugval op de eigen
 * opslag van de app.
 */

'use strict';

const queryCompiler = require('../queryCompiler');
const rlsGateway = require('../rlsGateway');
const studioAppDbStore = require('../../stores/studioAppDbStore');
const studioAppDataStore = require('../../stores/studioAppDataStore');
const { assertRowQuota, assertDbByteQuota } = require('../studioAppQuota');
// De rechtenbeslissing voor de tweede tabelsoort — gedeeld met dataReadRunner.
const datatableSource = require('../datatableSource');
const {
    findTable, buildServerScope, resolveBinding, resolveValues, coerceRecordId, writeViewer,
} = require('./shared');
const log = require('../../telemetry/log');

// ── Record writes ───────────────────────────────────────────────────

/**
 * THE record-write choke point. Every server-side create/update of an app
 * record — the data route (POST/PATCH records), the create_record /
 * update_record sequence steps, AI seeding, template install — funnels through
 * here so RLS and storage quotas can never be bypassed by a second write path.
 *
 *   writeRecord(app, model, table, values, { viewer, recordId })
 *     viewer   — { id, role, ... }: role drives RLS (assertCanWrite + access
 *                filter); the other attributes feed row-filter params.
 *     recordId — absent → CREATE (row + byte quotas asserted); present →
 *                UPDATE of that record (byte quota only; 0 changes means the
 *                row is missing OR outside the viewer's scope).
 *
 * `values` are RESOLVED column values ({ [col]: value }) — the compiler drops
 * system columns, rejects unknown fields (422) and coerces per type. Quota
 * failures propagate as studioAppQuota errors { status:409,
 * code:'quota_exceeded', limit, used }. Deletes deliberately do NOT come
 * through here — they stay quota-free so a full app can shrink.
 *
 * Returns { id, created:true } or { id, updated, changes }.
 *
 * EEN GEKOPPELDE TABEL GAAT HIER NIET DOOR. `table.source` wordt als EERSTE
 * gelezen: de rijen van zo'n tabel staan in een Studio-datatabel en de rechten
 * erop zijn niet die van de app. De weigering die dan valt is een `readError`
 * (status + `safe:true`) en wordt door de routers letterlijk doorgegeven; hij
 * is nooit een terugval op `studioAppDbStore`.
 */
async function writeRecord(app, model, table, values, { viewer, recordId, expectedUpdatedAt = null } = {}) {
    if (datatableSource.isDatatableBacked(table)) {
        return writeDatatableRecord(app, table, values, { viewer, recordId, expectedUpdatedAt });
    }
    const v = (viewer && typeof viewer === 'object') ? viewer : {};
    const role = v.role ?? null;

    if (recordId === undefined || recordId === null) {
        // 403 if this role may not create in this table at all — before quotas
        // so a forbidden write never reads usage.
        rlsGateway.assertCanWrite(table, role, 'create');
        await assertRowQuota(app, table.key);  // 409 at per-table/app row caps
        await assertDbByteQuota(app);          // 409 at the DB byte ceiling
        const { sql, params, id } = queryCompiler.compileInsert(table, values, {
            createdBy: v.id ?? null,
            orgId: app.organizationId || null,
        });
        await studioAppDbStore.exec(app.userId, app.id, sql, params);
        await bumpVersion(app, table.key);
        await bumpCount(app, table.key, 1);
        return { id, created: true };
    }

    // 403 if this role has no update scope; else 'own'/'all'.
    rlsGateway.assertCanWrite(table, role, 'update');
    await assertDbByteQuota(app); // updates only need headroom, not row budget
    const accessFilter = rlsGateway.compileAccessFilter(table, role, v, 'update');
    // expectedUpdatedAt (optional) makes this a compare-and-set: see
    // queryCompiler.compileUpdate. Only the record API passes it.
    const { sql, params } = queryCompiler.compileUpdate(table, recordId, values, accessFilter, { expectedUpdatedAt });
    const res = await studioAppDbStore.exec(app.userId, app.id, sql, params);
    const changes = (res && res.changes) ? res.changes : 0;
    if (changes > 0) await bumpVersion(app, table.key);
    return { id: recordId, updated: changes > 0, changes };
}

/**
 * The BATCH sibling of writeRecord: N creates in ONE store transaction, so a
 * failure part-way through leaves NOTHING behind (an ai_extract writes its whole
 * extraction or none of it). The same create-path gates apply — assertCanWrite,
 * then the row and byte quotas — asserted once for the batch, before anything is
 * compiled. Returns the created ids.
 *
 * Dezelfde eerste vraag als in `writeRecord`: een gekoppelde tabel gaat naar de
 * datatabel of nergens heen.
 */
async function writeRecordBatch(app, model, table, rows, { viewer } = {}) {
    if (datatableSource.isDatatableBacked(table)) {
        // De toestemming wordt óók voor een lege batch gevraagd, precies zoals
        // de eigen-opslag-tak hieronder: "je mocht dit niet" en "er was niets"
        // zijn verschillende antwoorden, en alleen het eerste is een weigering.
        const bound = await resolveWrite(app, table, viewer, 'create');
        return datatableInsert(bound, Array.isArray(rows) ? rows : []);
    }
    const v = (viewer && typeof viewer === 'object') ? viewer : {};
    const role = v.role ?? null;

    rlsGateway.assertCanWrite(table, role, 'create');
    if (rows.length === 0) return [];
    await assertRowQuota(app, table.key);
    await assertDbByteQuota(app);

    const statements = [];
    const ids = [];
    for (const values of rows) {
        const compiled = queryCompiler.compileInsert(table, values, {
            createdBy: v.id ?? null,
            orgId: app.organizationId || null,
        });
        statements.push({ sql: compiled.sql, params: compiled.params });
        ids.push(compiled.id);
    }
    await studioAppDbStore.batch(app.userId, app.id, statements);
    await bumpVersion(app, table.key);
    await bumpCount(app, table.key, ids.length);
    return ids;
}

/**
 * THE record-DELETE choke point — de derde ingang naast writeRecord/Batch.
 *
 * Verwijderen ging niet door writeRecord (deletes blijven quotavrij: dat is hoe
 * een volle app kan krimpen), en daardoor stond dezelfde compile-en-exec twee
 * keer geschreven: één keer in de delete_record-stap en één keer in de
 * DELETE-route. De route was de kopie die de tweede tabelsoort niet kende —
 * `DELETE FROM "klanten"` op de app-opslag, 404 op een rij die in de datatabel
 * gewoon bestaat, en op een tabel die ooit eigen opslag WAS de stille wis van de
 * oude schaduwrijen met alleen de app-rol als poort.
 *
 * Levert `{ id, deleted, changes }`; 0 rijen betekent "weg OF buiten de scope
 * van de kijker" en de aanroeper maakt daar één uniform "niet gevonden" van, zodat
 * het bestaan van een rij nooit uitlekt.
 */
async function eraseRecord(app, model, table, recordId, { viewer } = {}) {
    if (datatableSource.isDatatableBacked(table)) {
        const bound = await resolveWrite(app, table, viewer, 'delete');
        const changes = await datatableDelete(bound, recordId);
        return { id: recordId, deleted: changes > 0, changes };
    }
    const v = (viewer && typeof viewer === 'object') ? viewer : {};
    const role = v.role ?? null;
    rlsGateway.assertCanWrite(table, role, 'delete'); // 403 als deze rol niet mag
    const accessFilter = rlsGateway.compileAccessFilter(table, role, v, 'delete');
    const { sql, params } = queryCompiler.compileDelete(table, recordId, accessFilter);
    const res = await studioAppDbStore.exec(app.userId, app.id, sql, params);
    const changes = (res && res.changes) ? res.changes : 0;
    if (changes > 0) {
        await bumpVersion(app, table.key);
        await bumpCount(app, table.key, 0 - changes);
    }
    return { id: recordId, deleted: changes > 0, changes };
}

async function createRecord(app, model, step, ctx) {
    const table = findTable(model, step.tableId);
    if (!table) return { ok: false, error: 'Table not found' };
    if (datatableSource.isDatatableBacked(table)) return createDatatableRecord(app, table, step, ctx);

    const scope = buildServerScope(ctx);
    const values = resolveValues(step.values, ctx, scope);
    const { id } = await writeRecord(app, model, table, values, { viewer: writeViewer(ctx) });
    return { ok: true, result: { id, created: true } };
}

async function updateRecord(app, model, step, ctx) {
    const table = findTable(model, step.tableId);
    if (!table) return { ok: false, error: 'Table not found' };
    if (datatableSource.isDatatableBacked(table)) return updateDatatableRecord(app, table, step, ctx);

    const scope = buildServerScope(ctx);
    const recordId = coerceRecordId(resolveBinding(step.recordId, ctx, scope));
    if (!recordId) return { ok: false, error: 'Record not found' };

    const values = resolveValues(step.values, ctx, scope);
    // Optional compare-and-set (see STEP_SPECS.update_record.expectedUpdatedAt).
    const expectedRaw = step.expectedUpdatedAt !== undefined
        ? resolveBinding(step.expectedUpdatedAt, ctx, scope)
        : null;
    const expectedUpdatedAt = typeof expectedRaw === 'string' && expectedRaw ? expectedRaw : null;

    const { changes } = await writeRecord(app, model, table, values, {
        viewer: writeViewer(ctx), recordId, expectedUpdatedAt,
    });
    if (!changes) {
        // With a token, "no rows" most often means somebody else got there
        // first — say so, because "not found" would send the person looking
        // for a row that is right in front of them.
        if (expectedUpdatedAt) {
            return { ok: false, error: 'This record was changed by someone else — refresh and try again.', code: 'record_conflict' };
        }
        // 0 rows changed = the row is missing OR outside the viewer's scope; a
        // uniform "not found" so we never reveal which.
        return { ok: false, error: 'Record not found' };
    }
    return { ok: true, result: { id: recordId, updated: true, changes } };
}

async function deleteRecord(app, model, step, ctx) {
    const table = findTable(model, step.tableId);
    if (!table) return { ok: false, error: 'Table not found' };
    if (datatableSource.isDatatableBacked(table)) return deleteDatatableRecord(app, table, step, ctx);

    const scope = buildServerScope(ctx);
    const recordId = coerceRecordId(resolveBinding(step.recordId, ctx, scope));
    if (!recordId) return { ok: false, error: 'Record not found' };

    const { changes } = await eraseRecord(app, model, table, recordId, { viewer: writeViewer(ctx) });
    if (!changes) return { ok: false, error: 'Record not found' };
    return { ok: true, result: { id: recordId, deleted: true, changes } };
}

// ── Record writes on a DATATABLE-backed table ───────────────────────
//
// Dezelfde drie stappen als hierboven, maar op een andere opslag. Wat verschilt:
//
//   DE RECHTEN zijn al beslist. `datatableSource.resolveDatatableWrite` levert
//   de graad (MIN van de kijker, de app-eigenaar, de app-rol en de mode), heeft
//   `mode:'read'` al geweigerd en heeft beide `access`-blokken voor déze actie
//   al bevraagd. Hier valt geen enkele rechtenbeslissing meer — dat is precies
//   waarom hij daar staat en niet hier.
//
//   DE OPSLAG is `datatableDbStore` op de scope-sleutel, nooit
//   `studioAppDbStore`: die laatste is per app en per eigenaar en kent deze
//   rijen niet. De quota zijn die van de datatabel-TENANT
//   (`assertDatatableQuota`), niet de per-app quota — de rijen tellen mee in de
//   organisatie waar ze staan, niet in de app die ze toont.
//
//   DE DIALECT komt uit de resolutie (`pg`) en wordt overal uitgesproken. De
//   App Studio-engine-vlag kan op dezelfde server 'sqlite' zeggen; een compile
//   onder de verkeerde dialect is geen crash maar stilzwijgend andere SQL.

/**
 * Elke weigering van de rechtenlaag draagt `safe:true` — dezelfde vlag die het
 * leespad gebruikt (`appStudio/readError.js`) — en komt terug als een stapfout
 * MET de boodschap erin. Zonder die vertaling zou de dispatcher een 422 of een
 * 503 tot "Step failed" samenvouwen, en dan staat er "er ging iets mis" waar
 * "deze tabel is alleen-lezen gekoppeld" hoort te staan.
 *
 * Alles zonder de vlag gaat ONGEMOEID door naar de dispatcher: die kent
 * AccessError (403), CompileError (422) en de quota-vorm (409) al.
 */
function sourceRefusal(e) {
    if (!e || e.safe !== true) return null;
    return { ok: false, error: e.message, code: 'datatable_source' };
}

/**
 * A row write to a Solution stage's reference table (queryCompiler
 * RowsLockedError): the rows are the release's. Answered as a step failure
 * that keeps its code, so the app can say "change it in Dev and deploy"
 * instead of the dispatcher's generic "Step failed". The record API and the
 * other choke-point callers get the error itself (status 409, code
 * `managed_part`) and answer it as their own 409.
 */
function managedRefusal(e) {
    if (!(e instanceof queryCompiler.RowsLockedError)) return null;
    return { ok: false, error: e.message, code: 'managed_part' };
}

/**
 * De context waarin `datatableSource` een kijker verwacht — dezelfde vorm die
 * dataReadRunner meegeeft, zodat lezen en schrijven één beslissing delen.
 * `writeViewer` vult de rol aan wanneer de route alleen `{id}` stuurde.
 */
function sourceCtx(app, ctx) {
    return { app, viewerId: ctx.viewerId ?? null, role: ctx.role ?? null, viewer: writeViewer(ctx) };
}

/** De datatabel-store, lui gerequired zoals overal op dit pad (pg-pool). */
function dtStore() {
    return require('../../stores/datatableDbStore');
}

/**
 * De rechtenbeslissing, uit een `viewer` alleen — de vorm die de knooppunten
 * krijgen. `sourceCtx` hierboven doet hetzelfde vanuit een stap-ctx; allebei
 * eindigen ze in dezelfde `resolveDatatableWrite`, zodat de route en de stap
 * niet ieder hun eigen antwoord kunnen krijgen.
 */
function resolveWrite(app, table, viewer, action) {
    const v = (viewer && typeof viewer === 'object') ? viewer : {};
    return datatableSource.resolveDatatableWrite(
        { app, viewerId: v.id ?? null, role: v.role ?? null, viewer: v }, table, action,
    );
}

/**
 * N rijen in de datatabel zetten. Eén rij gaat door `exec`, meer door `batch` —
 * dezelfde alles-of-niets-belofte als `writeRecordBatch` op de eigen opslag.
 *
 * De quota is die van de TENANT (`assertDatatableQuota`), niet de per-app quota:
 * de rijen tellen mee in de organisatie waar ze staan. Dat is dezelfde controle
 * die routes/datatables.js en de automation-runner draaien, zodat een app niet het
 * ene pad is waarlangs een volle organisatie toch verder groeit.
 */
async function datatableInsert(bound, rows) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return [];
    // A locked reference table refuses before the quota is read: "the rows
    // are the release's" is the answer, not "the table is full".
    queryCompiler.assertRowsWritable(bound.tableMeta);
    const { assertDatatableQuota } = require('../../core/dataEngine/datatableLimits');
    await assertDatatableQuota(bound.scope, { table: bound.datatable, addRows: list.length });

    // Een datatabel die een EXTERNE BRON spiegelt (core/dataEngine/sources):
    // elke rij gaat éérst naar de bron, de kopie volgt uit het antwoord. In
    // één schrijfactie waar de bron een batch kent (een bestand dat één keer
    // herschreven wordt), rij voor rij waar niet — en een weigering is
    // `safe`, dus sourceRefusal geeft status/code/zin door zoals bij elke
    // andere bron-weigering.
    if (isSourceMirror(bound)) {
        const out = await mirrorWrites(bound).insertRows(mirrorCtx(bound), list);
        return out.inserted.map(r => r.id);
    }

    const statements = [];
    const ids = [];
    for (const values of list) {
        const ins = queryCompiler.compileInsert(bound.tableMeta, values, {
            // Wie de rij maakte is de KIJKER, niet de app-eigenaar: dat is het
            // eerlijke auditveld, en het is de kolom waarop `row_scope:'own'`
            // filtert — stempelden we de eigenaar, dan zou een lid zijn eigen rij
            // meteen niet meer terugzien.
            createdBy: bound.viewer.id ?? null,
            // De org van de TABEL, nooit die van de app: een persoonlijke tabel
            // heeft er geen, en de org van de app op zijn rijen stempelen is een
            // leugen waar de access-filter mee moet leven.
            orgId: bound.datatable.organizationId || null,
            dialect: bound.dialect,
        });
        statements.push({ sql: ins.sql, params: ins.params });
        ids.push(ins.id);
    }
    if (statements.length === 1) {
        await dtStore().exec(bound.scopeKey, bound.scopeKey, statements[0].sql, statements[0].params);
    } else {
        await dtStore().batch(bound.scopeKey, bound.scopeKey, statements);
    }
    await bumpDatatable(bound, ids.length);
    return ids;
}

function isSourceMirror(bound) {
    return require('../../core/dataEngine/sources').isSourceMirror(bound?.datatable);
}

/** De write-through van de bron-soort van deze tabel. */
function mirrorWrites(bound) {
    return require('../../core/dataEngine/sources').writeThrough(bound.datatable);
}

function mirrorCtx(bound) {
    return mirrorWrites(bound).contextOf({
        table: bound.datatable, scope: bound.scope, scopeKey: bound.scopeKey,
        tableMeta: bound.tableMeta, grade: bound.grade, viewerId: bound.viewer?.id ?? null,
    });
}

/** Eén rij in de datatabel wijzigen → het aantal geraakte rijen. */
async function datatableUpdate(bound, recordId, values, expectedUpdatedAt = null) {
    if (isSourceMirror(bound)) {
        const r = await mirrorWrites(bound).updateRow(mirrorCtx(bound), String(recordId), values, { expectedUpdatedAt });
        return r.changes;
    }
    const accessFilter = rlsGateway.compileAccessFilter(
        bound.tableMeta, bound.grade, bound.viewer, 'update', { dialect: bound.dialect });
    const { sql, params } = queryCompiler.compileUpdate(bound.tableMeta, recordId, values, accessFilter, {
        expectedUpdatedAt, dialect: bound.dialect,
    });
    const res = await dtStore().exec(bound.scopeKey, bound.scopeKey, sql, params);
    const changes = Number(res && res.changes) || 0;
    // Delta 0: een update verandert het rijaantal niet, maar wel de data-versie
    // waar de cache en een live kennisbron op kijken.
    if (changes) await bumpDatatable(bound, 0);
    return changes;
}

/** Eén rij uit de datatabel verwijderen → het aantal geraakte rijen. */
async function datatableDelete(bound, recordId) {
    if (isSourceMirror(bound)) {
        const r = await mirrorWrites(bound).deleteRow(mirrorCtx(bound), String(recordId));
        return r.changes;
    }
    const accessFilter = rlsGateway.compileAccessFilter(
        bound.tableMeta, bound.grade, bound.viewer, 'delete', { dialect: bound.dialect });
    const { sql, params } = queryCompiler.compileDelete(
        bound.tableMeta, recordId, accessFilter, { dialect: bound.dialect });
    const res = await dtStore().exec(bound.scopeKey, bound.scopeKey, sql, params);
    const changes = Number(res && res.changes) || 0;
    // `0 - changes`, niet `-changes`: met changes === 0 levert de unaire vorm
    // -0 op, en dat haalt de store als negatieve nul binnen.
    if (changes) await bumpDatatable(bound, 0 - changes);
    return changes;
}

/**
 * De datatabel-tak van `writeRecord` — create bij een lege recordId, anders een
 * update. Antwoordt in exact dezelfde vorm als de eigen-opslag-tak, zodat geen
 * enkele aanroeper weet welke van de twee hij raakte.
 */
async function writeDatatableRecord(app, table, values, { viewer, recordId, expectedUpdatedAt = null } = {}) {
    const creating = recordId === undefined || recordId === null;
    const bound = await resolveWrite(app, table, viewer, creating ? 'create' : 'update');
    if (creating) {
        const [id] = await datatableInsert(bound, [values]);
        return { id, created: true };
    }
    const changes = await datatableUpdate(bound, recordId, values, expectedUpdatedAt);
    return { id: recordId, updated: changes > 0, changes };
}

async function createDatatableRecord(app, table, step, ctx) {
    let bound;
    try {
        bound = await datatableSource.resolveDatatableWrite(sourceCtx(app, ctx), table, 'create');
    } catch (e) { const r = sourceRefusal(e); if (r) return r; throw e; }

    const scope = buildServerScope(ctx);
    const values = resolveValues(step.values, ctx, scope);
    let id;
    try {
        [id] = await datatableInsert(bound, [values]);
    } catch (e) { const r = managedRefusal(e); if (r) return r; throw e; }
    return { ok: true, result: { id, created: true } };
}

async function updateDatatableRecord(app, table, step, ctx) {
    const scope = buildServerScope(ctx);
    const recordId = coerceRecordId(resolveBinding(step.recordId, ctx, scope));
    if (!recordId) return { ok: false, error: 'Record not found' };

    let bound;
    try {
        bound = await datatableSource.resolveDatatableWrite(sourceCtx(app, ctx), table, 'update');
    } catch (e) { const r = sourceRefusal(e); if (r) return r; throw e; }

    const values = resolveValues(step.values, ctx, scope);
    // Optioneel compare-and-set, identiek aan de eigen-opslag-tak.
    const expectedRaw = step.expectedUpdatedAt !== undefined
        ? resolveBinding(step.expectedUpdatedAt, ctx, scope)
        : null;
    const expectedUpdatedAt = typeof expectedRaw === 'string' && expectedRaw ? expectedRaw : null;

    let changes;
    try {
        changes = await datatableUpdate(bound, recordId, values, expectedUpdatedAt);
    } catch (e) { const r = managedRefusal(e); if (r) return r; throw e; }
    if (!changes) {
        if (expectedUpdatedAt) {
            return { ok: false, error: 'This record was changed by someone else — refresh and try again.', code: 'record_conflict' };
        }
        // 0 rijen = de rij bestaat niet OF valt buiten de scope van de kijker;
        // één uniform antwoord, zodat het bestaan van een rij nooit uitlekt.
        return { ok: false, error: 'Record not found' };
    }
    return { ok: true, result: { id: recordId, updated: true, changes } };
}

async function deleteDatatableRecord(app, table, step, ctx) {
    const scope = buildServerScope(ctx);
    const recordId = coerceRecordId(resolveBinding(step.recordId, ctx, scope));
    if (!recordId) return { ok: false, error: 'Record not found' };

    let bound;
    try {
        bound = await datatableSource.resolveDatatableWrite(sourceCtx(app, ctx), table, 'delete');
    } catch (e) { const r = sourceRefusal(e); if (r) return r; throw e; }

    let changes;
    try {
        changes = await datatableDelete(bound, recordId);
    } catch (e) { const r = managedRefusal(e); if (r) return r; throw e; }
    if (!changes) return { ok: false, error: 'Record not found' };
    return { ok: true, result: { id: recordId, deleted: true, changes } };
}

/**
 * Rijteller + data-versie van de datatabel bijwerken.
 *
 * Best-effort, met dezelfde motivering als `bumpVersion` hieronder: de rij is
 * al gecommit, dus een mislukte boekhouding mag de stap niet alsnog rood maken.
 * `jobs/datatableRetention` hertelt `row_count` autoritatief.
 */
async function bumpDatatable(bound, delta) {
    try {
        const datatableStore = require('../../stores/datatableStore');
        await datatableStore.bumpAfterWrite(bound.datatable.id, bound.scope, delta);
    } catch (e) {
        log.warn(`[ActionExecutor] datatable bookkeeping failed for ${bound.datatable && bound.datatable.id}: ${e.message}`);
    }
}

async function bumpVersion(app, tableKey) {
    try {
        await studioAppDataStore.bumpDataVersion(app.id, tableKey, app.userId);
    } catch (e) {
        // A version-bump miss is a cache-staleness nuisance, not a data error —
        // the write already committed. Don't fail the step over it.
        log.warn(`[ActionExecutor] data-version bump failed for ${app.id}/${tableKey}: ${e.message}`);
    }
}

// Best-effort row-count delta (feeds the cached quota reads). Same rationale
// as bumpVersion: the write already committed, never fail over bookkeeping —
// recountRows (on schema saves) heals any drift authoritatively.
async function bumpCount(app, tableKey, delta) {
    try {
        await studioAppDataStore.bumpRowCount(app.id, tableKey, delta, app.userId);
    } catch (e) {
        log.warn(`[ActionExecutor] row-count bump failed for ${app.id}/${tableKey}: ${e.message}`);
    }
}

module.exports = {
    writeRecord,
    writeRecordBatch,
    eraseRecord,
    createRecord,
    updateRecord,
    deleteRecord,
};
