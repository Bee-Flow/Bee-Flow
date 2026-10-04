/**
 * `/api/webpages-preview/:id/tables/:tid/*` — de runtime-brug
 * `window.beeflowTables` van een webpagina naar een GEBONDEN datatable.
 *
 * ── DIT IS DE ANDERE HELFT VAN DE BRUG DAN AI/AUTOMATIONS ───────────
 *
 * Alle andere preview-bruggen draaien ACTS-AS-AUTHOR: de pagina roept de LLM
 * aan met het budget van de auteur, start diens automatiseringen, gebruikt diens
 * integraties. Dat kan daar, omdat de auteur die rechten expliciet heeft
 * weggegeven aan zijn eigen pagina.
 *
 * Een datatable is iets anders. Die heeft per persoon een eigen graad
 * (auth/datatableAccess), en een pagina delen mag nooit betekenen dat de
 * lezer de tabelrechten van de auteur leent. Deze routes draaien daarom als
 * de INGELOGDE BEZOEKER: `previewClaims.viewerUserId`, met zijn eigen
 * `gradeForPrincipal`, elke aanroep opnieuw berekend.
 *
 * Een token van vóór W3 heeft die claim niet. Dan wordt er NIET teruggevallen
 * op de eigenaar — dat zou precies het lek zijn — maar geweigerd met
 * `viewer_unknown`; de client haalt een vers token op en probeert opnieuw.
 *
 * ── EN PUBLIEK KOMT HIER NOOIT LANGS ────────────────────────────────
 *
 * `/w/<slug>` is een script-vrije, door DOMPurify gehaalde snapshot en de
 * anonieme brug kent alleen /ai/chat en /ai/stream. Op een publieke share
 * bestaat `window.beeflowTables` dus niet; wat daar van een tabel te zien is,
 * heeft de snapshot-writer server-side uit `publicColumns` gerenderd
 * (services/webpageBfTable.js). Deze routes zijn met opzet niet "ook publiek
 * met minder rechten": het preview-token is gebonden aan (userId, webpageId)
 * en mag nooit voor een publieke lezer worden hergebruikt. Wil men ooit een
 * lévende publieke tabel, dan is dat een APARTE, share-scoped, alleen-lezen,
 * rate-limited route op het patroon van de publieke share-brug.
 *
 * ── DE TWEE POORTEN, IN DEZE VOLGORDE ───────────────────────────────
 *   1. de binding — staat deze tabel in `bridge_grants.tables` van DEZE
 *      pagina, en met welke modus en kolommen? Niet gebonden → 404.
 *   2. de graad — mag DEZE BEZOEKER die tabel lezen (viewer) of schrijven
 *      (editor)? Dat beslist core/dataEngine/datatableRuntime.js, de gedeelde
 *      runner die ook de andere consumenten van een datatable gebruiken.
 * Allebei moeten ja zeggen. De binding kan de graad niet verbreden en de graad
 * de binding niet.
 *
 * ── WAT EEN PAGINA MAG STUREN ───────────────────────────────────────
 *
 * `beeflowTables.query(id, opts)` stuurt `opts` ONGEWIJZIGD als body, dus de
 * sleutels zijn die van de paginacode zelf. Elke sleutel die deze route niet
 * las viel weg, en weg betekende hier: minder filter, dus MEER rijen.
 *
 *   - `{ "filter": [...] }` (enkelvoud) en `{ "search": {...} }` — een vorm
 *     die de compiler kent maar deze brug niet doorgeeft — gaven allebei elke
 *     rij die de bezoeker mag zien, onder een 200.
 *   - `{ "filters": { "field": "status", "op": "eq", "value": "open" } }` —
 *     één filter in plaats van een lijst — werd door readRows' eigen
 *     `Array.isArray(filters) ? filters : []` een lege lijst, vóór de compiler
 *     zijn 'filters must be an array' kon zeggen. Ook: elke rij.
 *
 * Het schema legt alleen de SLEUTELS en hun soort vast. Wat er ín een filter
 * staat is de taal van de querycompiler, die per onbekende operator al een
 * 400 `bad_descriptor` met een bruikbare zin geeft; een schema dat die taal
 * naspeelt zou eerder antwoorden en minder zeggen. Om dezelfde reden blijven
 * `rowId`, `values` en `expectedUpdatedAt` bij de runner, die er zijn eigen
 * codes op heeft (`row_required`, `no_values`,
 * `expected_updated_at_required`).
 *
 * Een sortering is de uitzondering, omdat de compiler daar NIETS weigert:
 * resolvePrimarySort leest alleen `dir` of `direction` en maakt van al het
 * andere 'desc'. `{ field, order: 'asc' }` of `dir: 'ascending'` gaf dus
 * aflopend, onder een 200. Het schema kent daarom de sleutels van een
 * sortering (`field`, `dir`, `direction`) en hun twee richtingen.
 *
 * De bf-elementen sturen `{ limit }`; de shim stuurt `{ values }` en
 * `{ rowId, values, expectedUpdatedAt }`. Die komen allemaal ongewijzigd door.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();

const { requirePreviewToken } = require('../auth/webpagePreviewToken');
const { tableReadBridgeLimiter, tableWriteBridgeLimiter } = require('./webpagesPreviewRateLimits');
const { getBridgeGrants } = require('../stores/webpage/bridgeGrants');
const { resolveDatatablePrincipalForUser } = require('../auth/datatableAccess');
const datatableRuntime = require('../core/dataEngine/datatableRuntime');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

/** Een body die óók geen body accepteert: Express 5 laat `req.body` dan undefined. */
const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape).strict(),
);

const FILTERS_TEXT = 'filters is a list of { field, op, value } conditions.';
const MATCH_TEXT = 'match is "all" or "any".';
const SORT_TEXT = 'sort is { field, dir } or a list of those, dir "asc" or "desc".';
const LIMIT_TEXT = 'limit is a whole number of rows, at least 1.';
const CURSOR_TEXT = 'cursor is the nextCursor a previous page returned.';

/** Eén voorwaarde: een object — wat erin staat is aan de compiler. */
const clause = (message) => z.record(z.unknown(), { invalid_type_error: message });

// Elke weigering binnen een sortering is dezelfde zin: een union antwoordt met
// de eerste tak die tot een CHECK kwam, dus alleen een errorMap op de union
// zou "Unrecognized key(s) in object" laten doorlekken.
const sorted = { errorMap: () => ({ message: SORT_TEXT }) };
/** Een richting zoals resolvePrimarySort hem leest (hoofdletters telden altijd al). */
const sortDir = z.string(sorted).refine((v) => ['asc', 'desc'].includes(v.toLowerCase()), SORT_TEXT);
/** Eén sortering: de sleutels die de compiler leest, en niets dat hij stil negeert. */
const SortClause = z.object({
    field: z.string(sorted).min(1, SORT_TEXT),
    dir: sortDir.optional(),
    direction: sortDir.optional(),
}, sorted).strict();

// `null` is "niet ingesteld" en blijft dat: paginacode schrijft makkelijk
// `filters: actief ? [f] : null`, en dat vraagt om precies alle rijen.
const QueryBody = bodyOf({
    filters: z.array(clause(FILTERS_TEXT), { invalid_type_error: FILTERS_TEXT }).nullish(),
    match: z.enum(['all', 'any'], { errorMap: () => ({ message: MATCH_TEXT }) }).nullish(),
    sort: z.union([SortClause, z.array(SortClause)], { errorMap: () => ({ message: SORT_TEXT }) }).nullish(),
    // Een getal als tekst ("20" uit een data-attribuut) telde altijd al; 0 of
    // een woord gaf stil de standaardpagina en is nu een zin.
    limit: z.coerce.number({ invalid_type_error: LIMIT_TEXT }).int(LIMIT_TEXT).min(1, LIMIT_TEXT).nullish(),
    cursor: z.string({ invalid_type_error: CURSOR_TEXT }).nullish(),
});

const InsertBody = bodyOf({ values: z.unknown() });
const UpdateBody = bodyOf({ rowId: z.unknown(), values: z.unknown(), expectedUpdatedAt: z.unknown() });

/**
 * Elke weigering hier GOOIT, in plaats van zelf te antwoorden.
 *
 * Een helper die `res` schrijft én `null` teruggeeft, laat de aanroeper met
 * "en nu?" achter: vergeet die één `return` dan blijft het verzoek hangen tot
 * de browser opgeeft — geen fout, geen antwoord, niets in de log. Eén
 * `catch`-arm die alles afhandelt maakt dat onmogelijk.
 */
function refuse(status, code, message) {
    const e = new Error(message);
    e.status = status;
    e.code = code;
    e.safe = true;
    return e;
}

/**
 * De bezoeker.
 *
 * Nooit `previewClaims.userId` als terugval: dat is de EIGENAAR van de pagina,
 * en die terugval zou elke lezer van een gedeelde pagina de tabelrechten van de
 * auteur geven.
 */
function requireViewer(req) {
    const viewerUserId = req.previewClaims?.viewerUserId || null;
    if (!viewerUserId) {
        throw refuse(401, 'viewer_unknown',
            'This preview token does not say who is viewing. Reload the page to get a new one.');
    }
    return viewerUserId;
}

/**
 * De binding voor `:tid` op deze pagina.
 *
 * `write` vraagt om de LETTERLIJKE modus 'readwrite'; de normalizer heeft al
 * elke andere waarde tot 'read' versmald, dus hier hoeft alleen die ene string
 * te worden herkend.
 */
async function requireBinding(req, { write = false } = {}) {
    const grants = await getBridgeGrants(req.previewClaims.webpageId);
    const binding = (grants.tables || []).find(t => t.datatableId === req.params.tid) || null;
    if (!binding) {
        // 404, niet 403: of deze pagina aan een tabel hangt is geen informatie
        // die een bezoeker mag aftasten.
        throw refuse(404, 'table_not_bound', 'This page is not linked to that table');
    }
    if (write && binding.mode !== 'readwrite') {
        throw refuse(403, 'binding_read_only', 'This page may only read that table');
    }
    return binding;
}

/** Elke weigering met `safe` mag letterlijk terug; de rest wordt een 500. */
function sendError(res, err, fallback) {
    if (err && err.safe === true && typeof err.status === 'number') {
        return res.status(err.status).json({
            error: err.message,
            ...(err.code ? { code: err.code } : {}),
            ...(err.row ? { row: err.row } : {}),
        });
    }
    // Een CompileError komt van de descriptor die de pagina zélf stuurde
    // (een onbekende operator, een lijst waar er geen mag) — dat is een
    // 400 met een bruikbare tekst, geen interne fout.
    if (err && err.name === 'CompileError') {
        return res.status(400).json({ error: err.message, code: 'bad_descriptor' });
    }
    log.error(`[WebpagesPreview/tables] ${fallback}:`, err && err.message);
    return res.status(500).json({ error: fallback });
}

/** De bezoeker + zijn graad op deze tabel. Gooit als een van beide ontbreekt. */
async function resolveFor(req, needed) {
    const principal = await resolveDatatablePrincipalForUser(requireViewer(req));
    return datatableRuntime.resolveForPrincipal(req.params.tid, principal, { needed });
}

// ── Lezen ────────────────────────────────────────────────────────────

router.post('/:id/tables/:tid/query', requirePreviewToken, tableReadBridgeLimiter, validate({ body: QueryBody }), async (req, res) => {
    try {
        const binding = await requireBinding(req);
        const resolved = await resolveFor(req, 'viewer');
        const { filters, match, sort, limit, cursor } = req.body;
        const out = await datatableRuntime.readRows(resolved, {
            allowColumns: binding.columns,
            filters, match, sort, limit, cursor,
        });
        res.json(out);
    } catch (err) {
        sendError(res, err, 'Could not read the table');
    }
});

// ── Schrijven ────────────────────────────────────────────────────────

router.post('/:id/tables/:tid/insert', requirePreviewToken, tableWriteBridgeLimiter, validate({ body: InsertBody }), async (req, res) => {
    try {
        const binding = await requireBinding(req, { write: true });
        const resolved = await resolveFor(req, 'editor');
        const out = await datatableRuntime.insertRow(resolved, {
            allowColumns: binding.columns,
            values: req.body.values,
        });
        res.json({ ok: true, id: out.id });
    } catch (err) {
        sendError(res, err, 'Could not add the row');
    }
});

router.post('/:id/tables/:tid/update', requirePreviewToken, tableWriteBridgeLimiter, validate({ body: UpdateBody }), async (req, res) => {
    try {
        const binding = await requireBinding(req, { write: true });
        const resolved = await resolveFor(req, 'editor');
        const out = await datatableRuntime.updateRow(resolved, {
            allowColumns: binding.columns,
            rowId: req.body.rowId,
            values: req.body.values,
            expectedUpdatedAt: req.body.expectedUpdatedAt,
        });
        res.json({ ok: true, row: out.row });
    } catch (err) {
        sendError(res, err, 'Could not save the row');
    }
});

module.exports = router;
