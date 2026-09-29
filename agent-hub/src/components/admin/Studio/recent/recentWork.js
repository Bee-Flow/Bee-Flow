import { API_BASE, authFetch } from '../../../../utils/helpers';
import {
    RECENT_STATUS, STUDIO_RECENT_SOURCES, normaliseRecentRows, recentStatusOf,
} from '../../../../utils/studioRecentSources';

/**
 * "Laatst bewerkt" op het Startscherm van Studio — het MODEL (Track H3).
 *
 * Eén lijst over alle secties heen, samengevoegd uit de negen bronnen die
 * utils/studioRecentSources.js al beschrijft. Dat register wordt hier NIET
 * overgeschreven: de URL, de envelope-uitpakker, de veldmapper én de
 * statuslezer komen daarvandaan. Een tweede lijst met endpoints ernaast is
 * precies de variant die na een half jaar een ander antwoord geeft dan de
 * flyout in de zijbalk.
 *
 * ── Het model komt van actionChecks/attentionChecks ─────────────────────────
 *
 *   - NETWERK ZIT ALLEEN in fetchSection; oordelen is een pure functie op een
 *     gewoon object, apart geëxporteerd en apart getest;
 *   - elke sectie draait in zijn eigen catch: één lijst die omvalt noemt zijn
 *     eigen gat en sleept de lijst niet mee;
 *   - het resultaat draagt DRIE waarden, geen twee: gevonden / niets gevonden
 *     / niet kunnen kijken (search.js's errors[], completeness.js's
 *     unavailable[]). `complete` is het enige recht om "nog niets bewerkt" te
 *     zeggen.
 *
 * ── Geen rechten-gok in de client ───────────────────────────────────────────
 *
 * Er staat bewust GEEN permissiegate per bron in dit bestand. /agents/all
 * eist manage_agents, maar een client die dat zelf beoordeelt verbergt de
 * sectie vroeg of laat voor iemand die het recht wél heeft (RunsStudio houdt
 * dezelfde regel: de server is de autoriteit en weigert in woorden). Dus
 * vragen we het, en LEZEN we het antwoord:
 *
 *   403            de server weigert → `skipped`. Niet van jou, dus ook geen
 *                  gat: er is niets verloren dat jij had kunnen zien
 *   401 / 5xx /    we hebben niet kunnen kijken → `unavailable`, en dat staat
 *   onleesbaar     op het scherm
 *
 * Een sectie die de gate van het Studio-register al niet haalt (`locked`)
 * wordt niet eens gevraagd — die staat er als bordje, niet als deur.
 *
 * ── Waarom NIET rankStudioItems ─────────────────────────────────────────────
 *
 * utils/studioRecents.js rangschikt eerst op "door jou geopend op dit
 * apparaat" en pas daarna op updatedAt. Dat is het goede antwoord op "waar
 * was ik mee bezig" in de zijbalkflyout, en het VERKEERDE antwoord op een
 * kop die "Laatst bewerkt" heet: een agent die je vanochtend alleen opende
 * zou boven een tabel staan waar vandaag echt in geschreven is. Deze lijst
 * sorteert dus op updatedAt, één betekenis per kop.
 *
 * ── Wat dit kost ────────────────────────────────────────────────────────────
 *
 * Maximaal negen verzoeken, ÉÉN keer, bij het openen van Start — geen timer.
 * De rail pollt de aantallen al elke 30s; een tweede poller die dezelfde
 * lijsten elke halve minuut ophaalt zou dat veelvoudig maken. Alleen secties
 * die deze persoon kan openen worden gevraagd.
 */

/** Zoveel rijen toont de lijst. Een "recente" lijst is een greep, geen inventaris. */
export const RECENT_LIMIT = 8;

/**
 * Het woord bij een statuscode, plus de inkt waarin het staat.
 *
 * De twee onderste zijn geen status maar de twee manieren waarop er geen is
 * (zie RECENT_STATUS in studioRecentSources.js). Ze krijgen bewust dezelfde
 * neutrale inkt als "concept": een groen vinkje op een rij die geen status
 * meldt is precies de verzonnen geruststelling die deze lijst niet mag geven.
 */
export const STATUS_LABELS = Object.freeze({
    [RECENT_STATUS.FAILED]: { key: 'studio.recent.status_failed', fallback: 'Failed', tone: 'var(--error)' },
    [RECENT_STATUS.PROCESSING]: { key: 'studio.recent.status_processing', fallback: 'Processing', tone: 'var(--warning)' },
    [RECENT_STATUS.UNPUBLISHED_CHANGES]: { key: 'studio.recent.status_unpublished_changes', fallback: 'Unpublished changes', tone: 'var(--warning)' },
    [RECENT_STATUS.PUBLISHED]: { key: 'studio.recent.status_published', fallback: 'Published', tone: 'var(--success)' },
    [RECENT_STATUS.ACTIVE]: { key: 'studio.recent.status_active', fallback: 'On', tone: 'var(--success)' },
    [RECENT_STATUS.READY]: { key: 'studio.recent.status_ready', fallback: 'Ready', tone: 'var(--success)' },
    [RECENT_STATUS.DRAFT]: { key: 'studio.recent.status_draft', fallback: 'Draft', tone: 'var(--text-tertiary)' },
    [RECENT_STATUS.PAUSED]: { key: 'studio.recent.status_paused', fallback: 'Paused', tone: 'var(--text-tertiary)' },
    [RECENT_STATUS.UNKNOWN]: {
        key: 'studio.recent.status_unknown', fallback: 'Status unknown', tone: 'var(--text-tertiary)',
        hintKey: 'studio.recent.status_unknown_hint',
        hintFallback: 'This list reports a status for this kind, but this row carried none.',
    },
    [RECENT_STATUS.UNSUPPORTED]: {
        key: 'studio.recent.status_unsupported', fallback: 'No status', tone: 'var(--text-tertiary)',
        hintKey: 'studio.recent.status_unsupported_hint',
        hintFallback: 'This kind does not report a status in this list.',
    },
});

/** Het label bij een code; nooit undefined, want er staat altijd een woord op de rij. */
export function statusLabel(status) {
    return STATUS_LABELS[status] || STATUS_LABELS[RECENT_STATUS.UNKNOWN];
}

/* ── De bronnen die deze persoon mag vragen ───────────────────────────────── */

/**
 * De secties waaruit deze lijst wordt opgebouwd, afgeleid uit de twee
 * registers: `sections` (de al gegate rijen uit studioNav.js) doorsneden met
 * STUDIO_RECENT_SOURCES.
 *
 * Vier soorten secties vallen af, en ze zijn niet hetzelfde:
 *   - `locked`      → skipped. Een bordje, geen deur; er valt niets te lezen
 *   - ingebouwd, geen bron → stil. Formulieren en Runs hebben er bewust geen:
 *                     een formulier IS een automation (en komt dus via aiTasks
 *                     binnen), en een run is een gebeurtenis, geen ding dat
 *                     iemand bewerkt
 *   - RUNTIME-MODULE, geen bron → NIET stil. Een op afstand geïnstalleerde
 *                     module staat wél in `sections` maar heeft geen
 *                     endpoint-contract dat deze lijst kan lezen. Zwijgen zou
 *                     betekenen dat iemand die alleen daarin werkt "Nothing
 *                     edited yet" te zien krijgt met `complete: true` — een
 *                     geruststelling over werk dat we niet gevraagd hebben.
 *                     Ze gaan dus naar `unsupported`, met naam
 *   - geen id/URL   → stil; een descriptor zonder segment kan nergens heen
 */
export function recentSourcesFor(sections) {
    const asked = [];
    const skipped = [];
    const unsupported = [];
    for (const app of sections || []) {
        if (!app || !app.id) continue;
        const source = STUDIO_RECENT_SOURCES[app.id];
        if (!source || typeof source.url !== 'string' || !source.url) {
            // Een runtime-module herken je aan haar locale-bewuste label().
            // Een ingebouwde sectie zonder bron is een bewuste keuze hierboven.
            if (typeof app.label === 'function') unsupported.push(app.id);
            continue;
        }
        if (!app.urlSegment) continue;
        if (app.locked) { skipped.push(app.id); continue; }
        asked.push({
            sectionId: app.id,
            kind: app.kind || null,
            urlSegment: app.urlSegment,
            url: source.url,
        });
    }
    return {
        asked,
        skipped: [...new Set(skipped)].sort(),
        unsupported: [...new Set(unsupported)].sort(),
    };
}

/* ── De pure evaluator ────────────────────────────────────────────────────── */

/** Een leesbare tijdstempel in ms, of null. NaN is geen tijd. */
export function timeOf(updatedAt) {
    if (!updatedAt) return null;
    const t = new Date(updatedAt).getTime();
    return Number.isFinite(t) ? t : null;
}

/**
 * Eén payload → rijen die het scherm kan tekenen.
 *
 * Rij voor rij door de mapper van het register, zodat de RUWE rij (waar de
 * status op zit) en de genormaliseerde rij (waar naam en omschrijving op
 * zitten) bij elkaar blijven; normaliseRecentRows gooit rijen zonder id weg,
 * dus een index-koppeling over de hele lijst zou stilletjes verschuiven.
 *
 * Een body die geen array oplevert is GEEN lege sectie maar een antwoord dat
 * deze client niet kan lezen — `whole: false`, en de caller noemt het gat.
 */
export function evaluateRecentSection(section, payload) {
    const source = STUDIO_RECENT_SOURCES[section?.sectionId];
    if (!source) return { entries: [], whole: false };
    const rows = source.pick ? source.pick(payload) : payload;
    if (!Array.isArray(rows)) return { entries: [], whole: false };

    const entries = [];
    for (const row of rows) {
        const [item] = normaliseRecentRows(section.sectionId, [row]);
        if (!item) continue;
        entries.push({
            key: `${section.sectionId}:${item.id}`,
            id: item.id,
            sectionId: section.sectionId,
            kind: section.kind,
            name: item.name || null,
            description: item.description || null,
            updatedAt: item.updatedAt || null,
            at: timeOf(item.updatedAt),
            status: recentStatusOf(section.sectionId, row),
            // Dezelfde vorm als attentionLink.attentionPath: een rij die
            // nergens heen kan navigeert liever niet dan naar /null.
            path: `studio/${section.urlSegment}/${encodeURIComponent(item.id)}`,
        });
    }
    return { entries, whole: true };
}

/**
 * Alles wat gevonden is, nieuwste eerst, afgekapt op `limit`.
 *
 * Rijen zonder leesbare tijdstempel staan achteraan: ze kunnen niet in een
 * volgorde die "laatst bewerkt" heet, en weggooien zou werk verbergen. Bij
 * een gelijke tijd beslist de sleutel, zodat twee renders van dezelfde data
 * niet van volgorde wisselen.
 */
export function mergeRecentEntries(lists, limit = RECENT_LIMIT) {
    const all = [];
    for (const list of lists || []) for (const entry of list || []) if (entry) all.push(entry);
    all.sort((a, b) => {
        if (a.at === b.at) return String(a.key).localeCompare(String(b.key));
        if (a.at === null) return 1;
        if (b.at === null) return -1;
        return b.at - a.at;
    });
    return all.slice(0, Math.max(0, limit));
}

/* ── Het netwerk ──────────────────────────────────────────────────────────── */

/** Het ENIGE netwerk in deze module. Gooit bij alles wat geen leesbaar antwoord is. */
async function fetchSection(section) {
    const res = await authFetch(`${API_BASE}${section.url}`);
    // De server weigert in woorden: dit is niet van jou, en dus geen gat.
    if (res.status === 403) return { refused: true, payload: null };
    // 401 hoort hier NIET bij: een verlopen sessie is "niet kunnen kijken",
    // niet "niet van jou", en een lijst die daarop leeg oogt liegt.
    if (!res.ok) throw new Error(`GET ${section.url} → ${res.status}`);
    return { refused: false, payload: await res.json() };
}

/**
 * Eén sectie tot een oordeel. GOOIT NOOIT — de drie antwoorden:
 *   geweigerd   → geen rijen, geen gat
 *   gelezen     → de rijen die erin zaten
 *   gevallen    → geen rijen, en een gat met de naam van de sectie
 */
export async function runRecentSection(section) {
    try {
        const { refused, payload } = await fetchSection(section);
        if (refused) return { sectionId: section.sectionId, entries: [], refused: true, gap: false };
        const { entries, whole } = evaluateRecentSection(section, payload);
        return { sectionId: section.sectionId, entries, refused: false, gap: !whole };
    } catch {
        return { sectionId: section.sectionId, entries: [], refused: false, gap: true };
    }
}

/**
 * De hele lijst. Lost op naar
 *
 *   { items, unavailable, skipped, complete }
 *
 * `items`        de `limit` nieuwste rijen over alle gevraagde secties heen
 * `unavailable`  elke sectie die niet gelezen kon worden — het scherm noemt ze
 * `skipped`      secties die niet van deze persoon zijn (gelockt of 403):
 *                geen gat, en geen reden om een waarschuwing te tonen die
 *                iedereen elke dag ziet en daarom leert negeren
 * `unsupported`  secties waarvoor deze build geen lijst kan lezen
 * `complete`     geen enkel gat, geen onbeantwoorde poort en geen onleesbare
 *                sectie — het enige recht om "nog niets bewerkt" te zeggen in
 *                plaats van "we konden niet overal kijken"
 */
export async function runRecentWork(sections, { limit = RECENT_LIMIT, gatesResolved = true } = {}) {
    const { asked, skipped: locked, unsupported } = recentSourcesFor(sections);
    const results = await Promise.all(asked.map((section) => runRecentSection(section)));
    const unavailable = results.filter((r) => r.gap).map((r) => r.sectionId).sort();
    const refused = results.filter((r) => r.refused).map((r) => r.sectionId);
    // DE POORTEN ZELF ZIJN EEN ANTWOORD DAT KAN ONTBREKEN.
    //
    // resolveStudioNav LAAT een gegate sectie helemaal weg zolang het
    // entitlements-antwoord er niet is of omviel (studioApps.jsx:138-141;
    // studioNav.js zet lockReason dan bewust op () => null, want een licentie
    // die nog laadt mag niet als "hogere plan nodig" op het scherm komen).
    // Zo'n sectie staat dus NIET in `sections`, en deze functie kan haar niet
    // missen. Zonder deze vlag is het gevolg dat we zeven lijsten nooit vragen
    // en er "Nothing edited yet" met `complete: true` overheen zetten — een
    // schone gezondheidsverklaring over lijsten die nooit gevraagd zijn, in de
    // gewone laadseconde van élke opening. Onbekend versmalt: geen recht op de
    // geruststelling zolang de poorten geen antwoord hebben.
    const gateGap = gatesResolved ? [] : ['gates'];
    return {
        items: mergeRecentEntries(results.map((r) => r.entries), limit),
        unavailable: [...gateGap, ...unavailable],
        skipped: [...new Set([...locked, ...refused])].sort(),
        // Secties die deze build niet kan lezen. Geen gat (er is niets stuk)
        // en geen geheim (ze staan met naam op het scherm), maar ook geen
        // reden om te zeggen dat er niets bewerkt is.
        unsupported,
        complete: unavailable.length === 0 && gateGap.length === 0 && unsupported.length === 0,
    };
}

/**
 * De soorten op deze lijst die geen status melden, in de volgorde waarin ze
 * op het scherm staan. Het scherm zet er één zin onder; zonder die zin is een
 * rij zonder statuswoord een lege plek zonder uitleg.
 */
export function statuslessKinds(items) {
    const out = [];
    for (const item of items || []) {
        if (item?.status !== RECENT_STATUS.UNSUPPORTED) continue;
        const kind = item.kind || item.sectionId;
        if (kind && !out.includes(kind)) out.push(kind);
    }
    return out;
}

export default runRecentWork;
