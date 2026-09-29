/**
 * testSetFacts — de FEITEN achter de testset-kaart, los van hoe ze getekend
 * worden (Bee Flow Builder-herontwerp, sep 2026; A4 deel D).
 *
 * Puur: erin gaat wat `GET /agents/:id/tests` en `GET /agents/:id/tests/runs`
 * teruggeven, eruit komen feiten — geen zinnen. De zinnen staan in de kaart,
 * want daar staan ook de letterlijke `t()`-sleutels die de i18n-guard leest.
 *
 * ── "11 / 12 GOED" IS EEN TELLING OVER ÉÉN RUN ──────────────────────
 * En dus geen eigenschap van de testset. Vier toestanden, en drie ervan mogen
 * NOOIT als een getal op het scherm komen:
 *
 *   never       er is nooit gedraaid. Dat is niet "0 / 12 goed" — dat getal
 *               zou beweren dat twaalf vragen zijn gesteld en twaalf keer
 *               fout beantwoord. Er is niets gevraagd.
 *   unknown     de laatste run kon niet gelezen worden (`lastRunUnknown`).
 *               Ook geen 0: "ik weet het niet" is een derde antwoord.
 *   unfinished  er staat een rij, maar hij spreekt zichzelf tegen — geen
 *               `total`, meer `passed` dan `total`, of een `items`-lijst die
 *               niet even lang is als `total`. Een run die halverwege omviel
 *               is geen resultaat, en "3 van de 3 groen" uit negen vragen is
 *               de meest misleidende regel die deze kaart kan tonen.
 *   result      een afgeronde run. Alleen hier staat een getal.
 *
 * De route weigert al een afgebroken run OP TE SLAAN (routes/agents/tests.js),
 * dus `unfinished` hoort zeldzaam te zijn. Hij staat er omdat de kaart die
 * belofte niet mag AANNEMEN: een rij van vóór die regel, een handmatige edit
 * of een half geschreven JSONB komt hier binnen als een gewone rij.
 *
 * ── EN HIJ BESCHRIJFT DE VRAGEN VAN TOEN ────────────────────────────
 * Een run beschrijft de vragen zoals ze op dat moment waren, en de agent zoals
 * die op dat moment draaide. Daarom rekent `summariseRun` er twee dingen bij
 * uit die de kaart moet kúnnen zeggen: hoeveel van de vragen van NU deze run
 * dekte (`coverage`), en of er sindsdien iets aan de set veranderd is
 * (`stale`). Zonder die twee leest "11 / 12 goed" als een uitspraak over de
 * set die er nu staat, en dat is precies wat het niet is.
 *
 * ── EEN WEIGERING IS GEEN MISLUKTE TEST ─────────────────────────────
 * "Er is geen model ingericht om deze antwoorden te beoordelen" komt terug als
 * HTTP-weigering vóór er ook maar één beurt gedraaid heeft. Dat mag nooit als
 * rode tests op de kaart landen: dan gaat iemand zijn agent repareren terwijl
 * er niets mis is met zijn agent. `refusalFor` vertaalt die antwoorden naar
 * een gesloten vocabulaire, zodat de kaart ze als weigering kan tekenen en de
 * telling ongemoeid laat.
 */

/** De vier toestanden van "wat weten we van de laatste run". */
export const RUN_STATE = Object.freeze({
    NEVER: 'never',
    UNKNOWN: 'unknown',
    UNFINISHED: 'unfinished',
    RESULT: 'result',
});

/** Wat er met één test gebeurde. Spiegelt `testSandbox.STATUSES`. */
export const ITEM_STATUS = Object.freeze(['pass', 'fail', 'blocked', 'error']);

/**
 * De volgorde waarin een probleem om aandacht vraagt.
 *
 * `fail` eerst: dat is het enige oordeel over de AGENT. `error` daarna — daar
 * weten we het niet, en niet-weten is dringender dan een verwachting die deze
 * run per definitie niet kon controleren. `blocked` als laatste: die zegt iets
 * over de sandbox, niet over de agent.
 */
const PROBLEM_RANK = Object.freeze({ fail: 0, error: 1, blocked: 2 });

/** Een eindig, niet-negatief geheel getal, of null. */
function intOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

/** Een tijdstip als millis, of null — nooit NaN, dat vergelijkt overal false. */
function timeOf(value) {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

/**
 * Is deze rij een AFGEROND resultaat?
 *
 * Alle drie de checks zijn "spreekt de rij zichzelf tegen", en alle drie
 * landen op `unfinished` in plaats van op een getal.
 */
function looksFinished(run) {
    const total = intOrNull(run.total);
    if (total === null || total === 0) return false;
    const passed = intOrNull(run.passed);
    if (passed === null || passed > total) return false;
    const items = run.results && Array.isArray(run.results.items) ? run.results.items : null;
    if (items && items.length !== total) return false;
    return true;
}

/**
 * Wat de kaart over de laatste run mag beweren.
 *
 * @param {object} input
 * @param {object|null} input.lastRun        de rij uit `GET /:id/tests`
 * @param {boolean} input.lastRunUnknown     de lezing mislukte
 * @param {Array} input.tests                de vragen zoals ze NU zijn
 * @returns {{state: string, passed: number|null, total: number|null,
 *            items: Array, itemsKnown: boolean, ranAt: string|null,
 *            version: number|null, source: string|null,
 *            unpublishedChanges: number|null,
 *            coverage: {ran: number, of: number|null}|null,
 *            stale: {added: boolean, changed: boolean, removed: boolean},
 *            isStale: boolean}}
 */
export function summariseRun({ lastRun = null, lastRunUnknown = false, tests = null } = {}) {
    const now = asArray(tests);
    const knowTests = Array.isArray(tests);
    const empty = {
        state: RUN_STATE.NEVER,
        passed: null, total: null,
        items: [], itemsKnown: false,
        ranAt: null, version: null, source: null, unpublishedChanges: null,
        coverage: null,
        stale: { added: false, changed: false, removed: false },
        isStale: false,
    };

    // Onbekend gaat vóór alles: een mislukte lezing die toevallig ook geen rij
    // opleverde is niet "nog nooit gedraaid".
    if (lastRunUnknown === true) return { ...empty, state: RUN_STATE.UNKNOWN };
    if (!lastRun || typeof lastRun !== 'object') return empty;

    const results = (lastRun.results && typeof lastRun.results === 'object') ? lastRun.results : {};
    const items = Array.isArray(results.items) ? results.items : null;
    const ranAt = lastRun.ranAt || null;
    const base = {
        ...empty,
        items: items || [],
        itemsKnown: !!items,
        ranAt,
        version: intOrNull(lastRun.version),
        source: typeof results.source === 'string' ? results.source : null,
        unpublishedChanges: intOrNull(results.unpublishedChanges),
    };

    if (!looksFinished(lastRun)) return { ...base, state: RUN_STATE.UNFINISHED };

    const total = intOrNull(lastRun.total);
    const passed = Math.min(intOrNull(lastRun.passed), total);

    // Dekking: deze run ging over `total` vragen; er staan er nu `of`. Bij de
    // rij hoort ook `results.testCount` — hoeveel er tóen waren — maar de
    // kaart praat tegen iemand die naar de lijst van NU kijkt, dus dat is het
    // getal dat naast de teller hoort.
    const ranAtMs = timeOf(ranAt);
    const ranIds = new Set((items || []).map(i => i && i.testId).filter(id => typeof id === 'string'));
    const stale = { added: false, changed: false, removed: false };
    if (ranAtMs !== null) {
        for (const t of now) {
            const created = timeOf(t && t.createdAt);
            const updated = timeOf(t && t.updatedAt);
            if (created !== null && created > ranAtMs) stale.added = true;
            else if (updated !== null && updated > ranAtMs) stale.changed = true;
        }
    }
    if (knowTests && ranIds.size > 0) {
        const liveIds = new Set(now.map(t => t && t.id).filter(id => typeof id === 'string'));
        for (const id of ranIds) if (!liveIds.has(id)) { stale.removed = true; break; }
    }

    return {
        ...base,
        state: RUN_STATE.RESULT,
        passed, total,
        // `of` is hoeveel vragen er NU staan — de kaart praat tegen iemand die
        // naar de lijst van nu kijkt. Kent hij die lijst niet (de lezing werd
        // geweigerd of mislukte), dan valt hij terug op `results.testCount`:
        // hoeveel er stónden toen deze run liep. `when` zegt welke van de twee
        // het is, zodat de zin erbij niet gaat liegen over WANNEER er zoveel
        // vragen waren.
        coverage: knowTests
            ? { ran: total, of: now.length, when: 'now' }
            : (intOrNull(results.testCount) === null
                ? { ran: total, of: null, when: 'now' }
                : { ran: total, of: intOrNull(results.testCount), when: 'then' }),
        stale,
        isStale: stale.added || stale.changed || stale.removed,
    };
}

/**
 * Waarom deze test niet groen is — als FEIT, niet als zin.
 *
 * De `reason` die de server opsloeg is Engels en komt uit een gesloten lijst;
 * de kaart schrijft zijn eigen vertaalbare regel uit `kind` + `names` en valt
 * alleen terug op die tekst als er niets anders is (`error`, waar de reden de
 * échte oorzaak draagt).
 */
export function problemFor(item) {
    if (!item || typeof item !== 'object') return null;
    const status = ITEM_STATUS.includes(item.status) ? item.status : 'error';
    if (status === 'pass') return null;

    const forbidden = asArray(item.forbiddenHits).filter(n => typeof n === 'string' && n);
    const missing = asArray(item.toolsMissing).filter(n => typeof n === 'string' && n);
    const withheld = asArray(item.toolsWithheld).filter(n => typeof n === 'string' && n);

    if (status === 'blocked') return { status, kind: 'withheld', names: withheld, reason: item.reason || '' };
    if (status === 'error') return { status, kind: 'ungraded', names: [], reason: item.reason || '' };
    // Een fail die door een FEIT beslist is, zegt welk feit — dat is preciezer
    // dan de zin van de gesloten lijst en het is niet door een model geschreven.
    if (forbidden.length) return { status, kind: 'forbidden', names: forbidden, reason: item.reason || '' };
    if (missing.length) return { status, kind: 'tools_missing', names: missing, reason: item.reason || '' };
    return { status, kind: `decided:${item.decidedBy || 'overall'}`, names: [], reason: item.reason || '' };
}

/**
 * De FAALREGEL: het ene niet-groene resultaat dat de kaart toont, plus hoeveel
 * er nog meer zijn.
 *
 * Eén regel en niet alle — de kaart is een samenvatting; "Bekijk" is waar de
 * rest staat. Welke er getoond wordt is niet willekeurig maar de dringendste
 * (zie PROBLEM_RANK), want de eerste in de lijst kan een `blocked` zijn
 * terwijl er verderop een echte fout staat.
 */
export function firstProblem(items) {
    const rows = asArray(items).filter(i => i && typeof i === 'object' && i.status !== 'pass');
    if (rows.length === 0) return null;
    let best = null;
    let bestRank = Infinity;
    rows.forEach((item, index) => {
        const rank = PROBLEM_RANK[item.status] === undefined ? PROBLEM_RANK.error : PROBLEM_RANK[item.status];
        if (rank < bestRank) { bestRank = rank; best = { item, index }; }
    });
    return {
        item: best.item,
        problem: problemFor(best.item),
        moreCount: rows.length - 1,
        totalProblems: rows.length,
    };
}

// ── Weigeringen ──────────────────────────────────────────────────────

/**
 * Het gesloten vocabulaire waarin de kaart een weigering kan tekenen.
 *
 * `retryable` is "heeft opnieuw proberen zin": een leescheck die omviel wel,
 * een model dat niet is ingericht niet. Een knop die belooft dat het aan jou
 * ligt terwijl er niets is ingericht, laat mensen dertig keer drukken.
 */
export const REFUSAL = Object.freeze({
    NO_GRADER: 'no_grader',
    NO_SUGGESTER: 'no_suggester',
    MODEL_UNREADABLE: 'model_unreadable',
    SUGGESTION_UNREADABLE: 'suggestion_unreadable',
    LIMIT: 'limit',
    CHECK_FAILED: 'check_failed',
    NOTHING_TO_RUN: 'nothing_to_run',
    NOT_EDITABLE: 'not_editable',
    NOT_FOUND: 'not_found',
    TOO_MANY: 'too_many',
    NOT_SAVED: 'not_saved',
    /**
     * De stream brak MIDDENIN af. Anders dan elke weigering hierboven: er is
     * wél getest, alleen niet alles. `run_failed` komt van de server pas nadat
     * er al `test_result`-events over de lijn zijn gegaan, dus de zin erbij
     * mag niet "Nothing was tested" zijn terwijl de uitslagen eronder staan.
     */
    RUN_STOPPED: 'run_stopped',
    UNKNOWN: 'unknown',
});

const BY_CODE = Object.freeze({
    no_grading_model: { kind: REFUSAL.NO_GRADER, retryable: false },
    no_suggestion_model: { kind: REFUSAL.NO_SUGGESTER, retryable: false },
    grading_model_unavailable: { kind: REFUSAL.MODEL_UNREADABLE, retryable: true },
    suggestion_model_unavailable: { kind: REFUSAL.MODEL_UNREADABLE, retryable: true },
    suggestion_unreadable: { kind: REFUSAL.SUGGESTION_UNREADABLE, retryable: true },
    limit_reached: { kind: REFUSAL.LIMIT, retryable: false },
    org_check_failed: { kind: REFUSAL.CHECK_FAILED, retryable: true },
    limit_check_failed: { kind: REFUSAL.CHECK_FAILED, retryable: true },
    no_tests: { kind: REFUSAL.NOTHING_TO_RUN, retryable: false },
    no_turn: { kind: REFUSAL.NOTHING_TO_RUN, retryable: false },
    agent_not_editable: { kind: REFUSAL.NOT_EDITABLE, retryable: false },
    too_many_tests: { kind: REFUSAL.TOO_MANY, retryable: false },
    not_saved: { kind: REFUSAL.NOT_SAVED, retryable: true },
    // De catch-all van de route (`/:id/tests/run`), en die vuurt PAS als de
    // stream al liep. Zonder deze regel viel hij op REFUSAL.UNKNOWN en dus op
    // "Could not run the tests. Nothing was tested." — met vijf resultaten
    // eronder op het scherm.
    run_failed: { kind: REFUSAL.RUN_STOPPED, retryable: true },
});

/**
 * Een antwoord dat geen run was.
 *
 * `null` betekent "dit was geen weigering". Alles wat wél een weigering is
 * krijgt een `kind` uit het vocabulaire hierboven — óók een code die dit
 * bestand niet kent, want een onbekende weigering is nog steeds een weigering
 * en mag zeker niet als testresultaat op de kaart komen.
 *
 * @param {{status?: number, body?: object, code?: string}} input
 */
export function refusalFor({ status = 0, body = null, code = null } = {}) {
    const httpOk = Number(status) >= 200 && Number(status) < 300;
    const bodyCode = (body && typeof body.code === 'string' && body.code) || null;
    const found = code || bodyCode;
    if (httpOk && !found) return null;
    const known = found && BY_CODE[found];
    return {
        kind: known ? known.kind : REFUSAL.UNKNOWN,
        code: found || null,
        status: Number(status) || 0,
        retryable: known ? known.retryable : true,
        // De zin van de server reist mee als laatste redmiddel; de kaart
        // schrijft zijn eigen vertaalde regel voor elke bekende soort.
        serverMessage: (body && typeof body.error === 'string' && body.error) || '',
    };
}

// ── Een run terwijl hij loopt ────────────────────────────────────────

/** Wat een lopende run kan zijn. Alleen COMPLETE is een resultaat. */
export const PROGRESS = Object.freeze({
    RUNNING: 'running',
    COMPLETE: 'complete',
    UNFINISHED: 'unfinished',
});

/** De begintoestand van een druk op Run — nog vóór het `start`-event. */
export function startProgress() {
    return { status: PROGRESS.RUNNING, total: null, done: 0, items: [], passed: null, notStored: null };
}

/**
 * Eén SSE-event van `POST /:id/tests/run` erin, de nieuwe toestand eruit.
 *
 * Puur en zonder React, zodat de belangrijkste regel testbaar is zonder een
 * stream: zolang `done` niet gezien is, is dit GEEN resultaat. Een `error`-
 * event zet hem op `unfinished`, niet op "0 goed" — een run die omviel heeft
 * geen uitslag, ook niet de slechtste.
 */
export function applyRunEvent(state, event, data) {
    const s = state && typeof state === 'object' ? state : startProgress();
    const payload = data && typeof data === 'object' ? data : {};
    switch (event) {
        case 'start':
            return { ...s, status: PROGRESS.RUNNING, total: intOrNull(payload.total), done: 0, items: [] };
        case 'test_result': {
            const items = [...s.items, payload];
            return { ...s, items, done: items.length };
        }
        case 'done':
            return {
                ...s,
                status: PROGRESS.COMPLETE,
                passed: intOrNull(payload.passed),
                total: intOrNull(payload.total) === null ? s.total : intOrNull(payload.total),
                // Een "Test als"-run wordt bewust niet opgeslagen; de kaart mag
                // hem dus tonen maar niet als de nieuwe laatste run bewaren.
                notStored: typeof payload.notStored === 'string' ? payload.notStored : null,
                run: payload.run || null,
            };
        case 'error':
            return { ...s, status: PROGRESS.UNFINISHED, refusal: refusalFor({ status: 0, body: payload }) };
        default:
            return s;
    }
}

/**
 * De stream is afgelopen. Alles wat op dat moment nog `running` staat is
 * onafgemaakt — de verbinding viel weg, de tab ging dicht, de server stopte.
 */
export function endProgress(state) {
    const s = state && typeof state === 'object' ? state : startProgress();
    if (s.status === PROGRESS.RUNNING) return { ...s, status: PROGRESS.UNFINISHED };
    return s;
}

/** Groen tellen doen we zelf: alleen `pass` telt, precies zoals de server. */
export function countPassed(items) {
    return asArray(items).filter(i => i && i.status === 'pass').length;
}

/**
 * De uitslag van de run die je ZOJUIST zag lopen.
 *
 * Waarom dit bestaat: de kaart viel na een afgeronde run terug op
 * `summariseRun(lastRun)`, en `lastRun` wordt met opzet NIET bijgewerkt voor
 * een run die niet bewaard is — een "Test als"-simulatie (per ontwerp nooit
 * opgeslagen) of een run waarvan het opslaan mislukte. De kopregel toonde dan
 * de telling van de VORIGE run terwijl de faalregel, de vraagregels en de
 * weigering eronder over de zojuist gedraaide run gingen. "11 of 12 passed"
 * boven twaalf rode vragen.
 *
 * `passed` komt bij voorkeur van het `done`-event (de server telt zelf) en valt
 * terug op onze eigen telling over de binnengekomen resultaten. `kept` zegt of
 * deze uitslag ergens is blijven staan; is hij dat niet, dan mag er geen
 * versieregel bij die over een ándere run gaat.
 *
 * @returns {{passed: number, total: number, kept: boolean, notStored: string|null}|null}
 *   null zolang er geen afgeronde run is om over te praten.
 */
export function justRanScore(progress) {
    if (!progress || typeof progress !== 'object') return null;
    if (progress.status !== PROGRESS.COMPLETE) return null;
    const items = asArray(progress.items);
    const passed = intOrNull(progress.passed) === null ? countPassed(items) : intOrNull(progress.passed);
    const total = intOrNull(progress.total) === null ? items.length : intOrNull(progress.total);
    return {
        passed: Math.min(passed, total),
        total,
        kept: !!progress.run && !progress.notStored,
        notStored: typeof progress.notStored === 'string' ? progress.notStored : null,
    };
}
