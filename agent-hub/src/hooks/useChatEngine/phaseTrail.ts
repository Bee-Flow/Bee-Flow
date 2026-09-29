/**
 * Het SPOOR van de fase-events van één beurt (A4 deel C).
 *
 * ── WAAROM DIT ER NIET AL WAS ──────────────────────────────────────────────
 *
 * De server zendt tijdens elke beurt `phase`-events: `{ stage, status:
 * 'start'|'end', detail?, durationMs? }` (server/core/agentRuntime/
 * phaseEvents.js). De client deed daar tot nu toe precies één ding mee — hij
 * zette ze op `msg.currentPhase`, de ene roterende regel boven de typebolletjes
 * (`ActivityIndicator`). Elke fase overschreef dus de vorige, en de eerste
 * letter van het antwoord wiste de hele regel (`contentFlusher`).
 *
 * Er was daardoor geen enkele plek waar ná afloop te zien was wat er gebeurd
 * was. Dit bestand maakt dat spoor: dezelfde events, opgeteld in de volgorde
 * waarin ze binnenkwamen, blijvend op het bericht.
 *
 * ── HET SPOOR VERZINT NIETS ────────────────────────────────────────────────
 *
 * Twee regels, en ze zijn allebei belangrijker dan ze eruitzien:
 *
 *  1. EEN 'end' ZONDER 'start' MAAKT GEEN RIJ. Een afsluiting die bij niets
 *     hoort is geen stap die gebeurd is; er een rij van maken zou een stap op
 *     het scherm zetten waarvan we het begin nooit hebben gezien.
 *  2. EEN HERHAALDE 'start' VAN DEZELFDE OPEN FASE IS DEZELFDE STAP.
 *     `startPrivacyScanPhase` zendt per gescand venster opnieuw een start met
 *     `detail: '3/6'`, zodat de live regel meebeweegt. Wie die naïef opstapelt
 *     laat één privacyscan als zes stappen in het spoor staan — een spoor dat
 *     meer werk toont dan er gedaan is, en dat is precies de geruststelling
 *     die dit paneel hoort te bestrijden.
 *
 * ── FASES SCHUIVEN OVER ELKAAR HEEN ────────────────────────────────────────
 *
 * `guardrails` loopt op het agentpad OM `privacy_scan` heen (guardrailsRunner
 * draait binnen de guardrails-fase). Het spoor is dus geen lijst van elkaar
 * opvolgende blokken en de duren mogen NIET opgeteld worden tot "zo lang duurde
 * de beurt" — dat telt de scan twee keer. Wie een totaal wil, neemt de
 * SPANWIJDTE (eerste start → laatste einde); zie `answerTrace.js`.
 *
 * Zuiver: geen React, geen DOM, geen tijd behalve wat er binnenkomt. Zodat
 * "wat staat er in het spoor" met platte objecten te testen is.
 *
 * Draaien: cd agent-hub && ./node_modules/.bin/vitest run src/hooks/useChatEngine/phaseTrail.test.js
 */

/**
 * Hoeveel stappen één beurt in het spoor mag achterlaten.
 *
 * Het agentpad kent negen stages, en herhaalde starts van dezelfde fase worden
 * samengevouwen — dus dit is geen begrenzing die in de praktijk bijt, maar een
 * bovengrens voor een stroom die niet ophoudt. Boven de grens komen er geen
 * nieuwe stappen meer bij; lopende stappen mogen nog wél afgesloten worden,
 * anders zou een spoor vol eeuwig-open stappen achterblijven.
 */
export const MAX_TRAIL_STEPS = 40;

/** A pre-LLM progress step (KB search, attachment OCR, guardrails, …). */
export interface PhaseEvent {
    stage?: string;
    status?: string;
    detail?: string | null;
    durationMs?: number;
}

/** One entry of the durable phase trail kept on a message. */
export interface PhaseTrailEntry {
    stage: string;
    detail: string | null;
    startedAt: number;
    endedAt?: number | null;
    durationMs?: number | null;
    [key: string]: unknown;
}

/** Een niet-lege, getrimde string, of null. */
function text(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

/** Sluit de laatste nog lopende rij van deze stage. Geen start ⇒ geen rij. */
function closeStep(
    rows: PhaseTrailEntry[],
    stage: string,
    data: PhaseEvent,
    now: number,
): PhaseTrailEntry[] | null {
    let at = -1;
    // Achteruit zoeken: een fase die twee keer liep hoort zijn eigen einde te
    // krijgen, niet dat van de vorige keer.
    for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i] && rows[i].stage === stage && rows[i].endedAt == null) { at = i; break; }
    }
    if (at < 0) return null; // regel 1: geen start ⇒ geen rij
    const row = rows[at];
    const next = rows.slice();
    next[at] = {
        ...row,
        endedAt: now,
        // De server meet zijn eigen duur; die is nauwkeuriger dan het verschil
        // van twee kloktikken hier. Zonder die meting valt het terug op de
        // onze — allebei echte metingen, geen schatting.
        durationMs: Number.isFinite(data.durationMs)
            ? data.durationMs
            : (Number.isFinite(row.startedAt) ? now - row.startedAt : null),
    };
    return next;
}

/** Open een stap, of schuif het detail op van dezelfde stap die nog loopt. */
function openStep(
    rows: PhaseTrailEntry[],
    stage: string,
    detail: string | null,
    now: number,
): PhaseTrailEntry[] | null {
    const last = rows.length > 0 ? rows[rows.length - 1] : null;
    // Regel 2: dezelfde fase die nog loopt is dezelfde stap.
    if (last && last.stage === stage && last.endedAt == null) {
        if (last.detail === detail) return null;
        const next = rows.slice();
        next[next.length - 1] = { ...last, detail };
        return next;
    }
    if (rows.length >= MAX_TRAIL_STEPS) return null;
    return [...rows, { stage, detail, startedAt: now, endedAt: null, durationMs: null }];
}

/**
 * Verwerk één `phase`-event in het spoor.
 *
 * Geeft dezelfde array-referentie terug als er niets te doen viel, zodat de
 * aanroeper een overbodige kopie van het bericht kan overslaan.
 *
 * `now` is injecteerbaar zodat een test niet op de echte klok hoeft te wachten.
 */
export function appendPhase(
    trail: PhaseTrailEntry[] | undefined,
    data: PhaseEvent,
    now: number = Date.now(),
): PhaseTrailEntry[] | undefined {
    const rows = Array.isArray(trail) ? trail : [];
    const stage = text(data && data.stage);
    if (!stage) return trail;
    const next = data.status === 'end'
        ? closeStep(rows, stage, data, now)
        : openStep(rows, stage, text(data.detail), now);
    return next || trail;
}

export default appendPhase;
