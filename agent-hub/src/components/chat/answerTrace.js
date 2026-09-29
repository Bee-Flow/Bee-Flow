/**
 * Het SPOOR van het laatste antwoord — welke regels er mogen staan, en welke
 * er ontbreken omdat niemand ze gemeten heeft.
 *
 * ── HET ONTWERP VROEG VIJF REGELS. VIER ZIJN ER TE METEN ───────────────────
 *
 * Het paneel toont vijf stappen: de vraag gelezen, een bron geraadpleegd, een
 * regel toegepast, een actie aangeboden-maar-niet-gestart, en het antwoord
 * geschreven. Elke regel moest hier tegen de EVENTS gelegd worden die de
 * server echt zendt, en dat liep niet overal goed af. Wat er wél is:
 *
 *   1 vraag        `phase processed_history` + `phase building_prompt`
 *                  (chatStream.js). Meet dat de beurt de vraag heeft ingelezen
 *                  en er een prompt van bouwde — NIET dat hij hem begrepen
 *                  heeft. Vandaar dat deze regel "gelezen" heet en niet
 *                  "begrepen": begrip meet niets in dit product, en een spoor
 *                  dat begrip claimt is precies de geruststelling die dit
 *                  paneel hoort te bestrijden.
 *   2 bron         `phase kb_search` (de auto-injectie) en/of een `kb_search`-
 *                  toolcall in `toolHistory`, plus de passages uit `kb_sources`.
 *   3 regel        de attributie-pass (`rule_attribution`). GEOORDEELD, geen
 *                  notulen — zie hieronder.
 *   4 actie        `tool_confirm` met de stand uit `toolConfirmStatus.js`.
 *   5 antwoord     `phase streaming_start` (met het model als detail) en het
 *                  antwoord zelf.
 *
 * ── EN WAT ER NIET IS, MET DE REDEN ────────────────────────────────────────
 *
 * TOON en TAAL. Het ontwerp wilde ze bij regel 5. `persona.tone.chips` en
 * `persona.language` bestaan wel degelijk (personaPrompt.js), maar dat is wat
 * er GEVRAAGD is — de rol die de bouwer typte. Niemand meet of het antwoord
 * die toon ook trof, en niets in de eventstroom draagt de taal van het
 * antwoord. Ze naast de gemeten regels zetten zou van een wens een uitslag
 * maken. Dus staan ze in `omitted`, met een reden, en nooit als feit.
 *
 * HET AANTAL RESULTATEN, soms. `kb_sources` gaat alleen over de lijn als de
 * agent `includeSourceReferences` aan heeft (knowledgeSearch.js), en de
 * project-KB-injectie zendt het nooit (contextEnrichment.js) — die persisteert
 * alleen. Een zoekstap zonder passages betekent dus "we weten het niet", niet
 * "nul gevonden". Daarom is het aantal dan `null` met reden `not_reported`;
 * er staat nooit een 0 waar niemand geteld heeft.
 *
 * DE ZOEKTERMEN, op het automatische pad. De auto-injectie zoekt zonder ook
 * maar iets over zijn zoekvraag te zenden; alleen de kb_search-TOOL draagt
 * `args.query`. Geen query in het spoor ⇒ `omitted`, geen gok.
 *
 * ── OPGETEKEND EN GEOORDEELD BLIJVEN GESCHEIDEN ────────────────────────────
 *
 * Regel 3 komt van een tweede model dat ná afloop de rol naast het antwoord
 * legde. Dat is een MENING. `answerChips.js` maakte daar al twee soorten
 * bewering van ('recorded' / 'judged') en die woordenlijst geldt hier
 * onverkort: de regelrij draagt `state: 'judged'` en de render moet hem in
 * vorm én plaats apart houden. Ze door elkaar zetten geeft de zwakste bewering
 * in het paneel het gezag van de sterkste.
 *
 * ── EEN ONTBREKENDE REGEL BEWEERT NIETS OVER DE AGENT ──────────────────────
 *
 * "Geen kennisstap opgetekend" is een uitspraak over de METING, niet over wat
 * de agent deed. Dat verschil zit in de woorden van elke reden hieronder, en
 * het is de reden dat er geen enkele reden bestaat die "de agent heeft niet
 * gezocht" zegt — dat weten we niet.
 *
 * Zuiver: geen React, geen t(), geen DOM. Zodat "welke regel mag hier staan"
 * met platte objecten te testen is.
 *
 * Draaien: cd agent-hub && ./node_modules/.bin/vitest run src/components/chat/answerTrace.test.js
 */

import { ruleChipsOf } from './MessageItem/answerChips';
import { documentCountOf } from './MessageItem/citationGroups';
import { confirmDecisionOf } from './MessageItem/toolConfirmStatus';

/** De vijf regels, in leesvolgorde. */
export const TRACE_ROWS = Object.freeze(['question', 'sources', 'rule', 'held_action', 'answer']);

/** De drie standen van een regel. 'judged' is er precies één: de attributie. */
export const TRACE_STATES = Object.freeze(['recorded', 'judged', 'missing']);

/**
 * Waarom een regel ontbreekt. Gesloten lijst — elke reden krijgt één zin in de
 * UI, en elke zin gaat over de meting, nooit over de agent.
 */
export const MISSING_REASONS = Object.freeze([
    /** Er is voor deze beurt niets opgetekend (bv. een herladen gesprek). */
    'no_trace',
    /** Er is wél opgetekend, maar zo'n stap zat er niet bij. */
    'not_recorded',
    /** De stap liep, maar dit getal is nooit over de lijn gekomen. */
    'not_reported',
    /** De extra regelcontrole draaide niet, of vond niets om te melden. */
    'no_attribution',
    /** Niets in dit product meet dit. */
    'not_measured',
    /** Er was geen proza om op te meten (bv. een antwoord dat alleen code is). */
    'no_prose',
]);

/** De feiten die per regel weggelaten kunnen zijn. Gesloten lijst. */
export const OMITTED_FACTS = Object.freeze([
    'query', 'results', 'model', 'tone', 'language', 'sentences',
]);

/** Citaten van een LIVE tabelrij. Geen document, geen passage — zie sourcesRow. */
const TABLE_ROW_KIND = 'datatable_row';

/** De fases die samen "de vraag is ingelezen" opleveren. */
const QUESTION_STAGES = Object.freeze(['processed_history', 'building_prompt']);

/** De toolnaam waarmee een agent zelf zijn kennisbank doorzoekt. */
const KB_TOOL = 'kb_search';

/** Zoals `HowIGotThisAnswer` telt: de denkstappen zijn geen tool. */
const HIDDEN_TOOL = 'sequentialthinking';

/** A table with neither a name nor a heading still counts as one table. */
const UNKNOWN_DOC = 'Unknown Source';

// ── Kleine hulpjes ───────────────────────────────────────────────────

function text(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

function missing(id, reason) {
    return { id, state: 'missing', reason, omitted: [] };
}

/**
 * De duren van een reeks stappen bij elkaar.
 *
 * Alleen te gebruiken op stappen die ELKAAR OPVOLGEN. Fases die over elkaar
 * heen schuiven (guardrails om privacy_scan) zou dit dubbel tellen — daarvoor
 * is `traceSpanMs`.
 */
function sumDurations(steps) {
    let total = null;
    for (const s of steps) {
        if (!s || !Number.isFinite(s.durationMs)) continue;
        total = (total || 0) + s.durationMs;
    }
    return total;
}

/** De tools die deze beurt draaide, zoals "How I got this answer" ze telt. */
export function toolStepsOf(msg) {
    const history = Array.isArray(msg?.toolHistory) ? msg.toolHistory : [];
    return history.filter(t => t && t.name !== HIDDEN_TOOL);
}

/** De duur van een toolcall uit zijn eigen kloktikken. */
function toolDurationMs(tool) {
    return Number.isFinite(tool?.endTime) && Number.isFinite(tool?.startTime)
        ? tool.endTime - tool.startTime
        : null;
}

// ── De vijf regels ───────────────────────────────────────────────────

/** 1 — de vraag is ingelezen en tot een prompt gemaakt. Niet: begrepen. */
function questionRow(trail, hasTrail) {
    const steps = trail.filter(r => QUESTION_STAGES.includes(r.stage));
    if (steps.length === 0) return missing('question', hasTrail ? 'not_recorded' : 'no_trace');
    return {
        id: 'question',
        state: 'recorded',
        // De stages staan erbij zodat de lezer ziet WAAROP deze regel rust.
        stages: steps.map(s => s.stage),
        ms: sumDurations(steps),
        omitted: [],
    };
}

/**
 * 2 — er is in de kennis gezocht: waarmee, en hoeveel het opleverde.
 *
 * ── EEN TABELRIJ IS GEEN DOCUMENT ─────────────────────────────────────────
 *
 * `msg.kbSources` draagt TWEE soorten citaat door hetzelfde event. Een
 * `kb_chunk` is een passage uit een document; een `datatable_row` is één rij
 * die op het moment van de vraag uit een tabel is gelezen — met de RIJNAAM als
 * titel. Ze samen tellen als "passages uit documenten" gaf bij drie
 * tabelrijen letterlijk "3 passages from 3 documents": er is één tabel
 * gelezen, geen drie documenten, en er is geen kennisbank geraadpleegd.
 * `answerChips.js` maakt dat onderscheid al expliciet; hier gold het niet, en
 * dan zeggen twee panelen op hetzelfde bericht iets anders over hetzelfde
 * event.
 */
function sourcesRow(trail, msg, hasTrail) {
    const phases = trail.filter(r => r.stage === KB_TOOL);
    const toolCalls = toolStepsOf(msg).filter(t => t.name === KB_TOOL);
    const sources = Array.isArray(msg?.kbSources) ? msg.kbSources.filter(Boolean) : [];
    const passages = sources.filter(s => s.kind !== TABLE_ROW_KIND);
    const tableRows = sources.filter(s => s.kind === TABLE_ROW_KIND);

    if (phases.length === 0 && toolCalls.length === 0 && sources.length === 0) {
        const knowsSomething = hasTrail || toolStepsOf(msg).length > 0;
        return missing('sources', knowsSomething ? 'not_recorded' : 'no_trace');
    }

    // Alleen de tool draagt zijn zoekvraag; de auto-injectie zendt er geen.
    // ALLE termen, niet de eerste: meerdere kb_search-calls in één beurt zijn
    // op het agentpad de normale gang van zaken, en de tweede term liet zich
    // eerst zonder een woord weglaten — terwijl de passages van beide
    // zoekopdrachten wél onder die ene term geteld werden.
    const queries = [...new Set(toolCalls.map(t => text(t.args?.query)).filter(Boolean))];
    const query = queries[0] || null;
    // Nul passages is hier GEEN nul resultaten — zie de kop.
    const results = passages.length > 0 ? passages.length : null;
    // Counted the way the sources panel and the chip row group them
    // (citationGroups.ts), so the three never disagree (BFSF-352).
    const documents = results ? documentCountOf(passages) : null;
    // De tabelhelft telt in zijn eigen eenheid: rijen, uit tabellen.
    const rows = tableRows.length > 0 ? tableRows.length : null;
    const tables = rows
        ? new Set(tableRows.map(s => text(s.sourceName) || text(s.section) || UNKNOWN_DOC)).size
        : null;
    const ms = phases.length > 0
        ? sumDurations(phases)
        : sumDurations(toolCalls.map(t => ({ durationMs: toolDurationMs(t) })));

    // Er is alleen iets over de KENNISBANK te melden als er ook een
    // kennisbankstap was. Een beurt die alleen een tabel las, laat geen
    // passages weg — die heeft er geen.
    const hadKbStep = phases.length > 0 || toolCalls.length > 0 || passages.length > 0;
    const omitted = [];
    if (hadKbStep && queries.length === 0) omitted.push({ fact: 'query', reason: 'not_recorded' });
    if (hadKbStep && results === null) omitted.push({ fact: 'results', reason: 'not_reported' });

    return {
        id: 'sources', state: 'recorded',
        query, queries, results, documents, rows, tables, ms, omitted,
    };
}

/** 3 — welke regel van de rol dit antwoord volgde. GEOORDEELD, geen notulen. */
function ruleRow(msg) {
    const rules = ruleChipsOf(msg);
    if (rules.length === 0) return missing('rule', 'no_attribution');
    return { id: 'rule', state: 'judged', rules, omitted: [] };
}

/** 4 — een actie die is aangeboden, en wat er daarna mee gebeurd is. */
function heldActionRow(msg, decided) {
    const calls = Array.isArray(msg?.pendingToolCalls)
        ? msg.pendingToolCalls.filter(c => c && typeof c === 'object')
        : [];
    // Géén `no_trace` hier: vastgehouden calls hangen niet aan het fase-spoor,
    // dus de afwezigheid zegt hetzelfde of er nu een spoor is of niet.
    if (calls.length === 0) return missing('held_action', 'not_recorded');

    const actions = calls.map((call, i) => {
        const { status, by } = confirmDecisionOf(call, decided);
        return {
            key: text(call.argsKey) || text(call.callId) || `held-${i}`,
            toolName: text(call.toolName),
            effect: text(call.effect),
            status,
            by,
        };
    });
    return {
        id: 'held_action',
        state: 'recorded',
        actions,
        openCount: actions.filter(a => a.status === 'pending').length,
        omitted: [],
    };
}

/** 5 — het antwoord is geschreven: door welk model, en hoe lang het werd. */
function answerRow(trail, msg, hasTrail) {
    const streaming = [...trail].reverse().find(r => r.stage === 'streaming_start') || null;
    const content = typeof msg?.content === 'string' ? msg.content : '';
    if (!streaming && !content) return missing('answer', hasTrail ? 'not_recorded' : 'no_trace');

    const model = streaming ? text(streaming.detail) : null;
    const omitted = [];
    if (!model) omitted.push({ fact: 'model', reason: 'not_recorded' });
    // De twee die het ontwerp vroeg en die niemand meet. Zie de kop.
    omitted.push({ fact: 'tone', reason: 'not_measured' });
    omitted.push({ fact: 'language', reason: 'not_measured' });

    // De bewaker hoort op de PROZA te staan, niet op de content. `content` kan
    // gevuld zijn met louter een codeblok; `countSentences` knipt dat er eerst
    // uit en gaf dan 0 terug — en dan stond er "Written by … · 0 sentences"
    // onder een antwoord dat wel degelijk tekst bevat. Dat is precies de 0
    // waar "niet geteld" hoort, die de kop van dit bestand verbiedt.
    const sentenceCount = content ? countSentences(content) : 0;
    const sentences = sentenceCount > 0 ? sentenceCount : null;
    if (sentences === null) omitted.push({ fact: 'sentences', reason: 'no_prose' });

    return {
        id: 'answer',
        state: 'recorded',
        model,
        sentences,
        omitted,
    };
}

// ── Metingen op het antwoord zelf ────────────────────────────────────

/**
 * Hoeveel zinnen het antwoord telt.
 *
 * Rekenwerk op de tekst die geleverd is, geen uitspraak over de tekst. De
 * regel: een zin eindigt op `. ! ? …` gevolgd door witruimte of het einde.
 * Daardoor telt `3.5 procent` niet als twee zinnen (de punt wordt gevolgd door
 * een cijfer) en `foo.bar()` ook niet.
 *
 * Codeblokken gaan er eerst uit: een blok JavaScript staat vol punten en zou
 * het getal wild opblazen — en een codeblok is sowieso geen proza.
 *
 * Blijft benaderend voor afkortingen ("bijv.", "dhr.") en voor een beletselteken
 * midden in een zin. Het is een telling van de levering, niet van de betekenis.
 */
export function countSentences(text_) {
    const raw = typeof text_ === 'string' ? text_ : '';
    const prose = raw
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`\n]*`/g, ' ')
        .trim();
    if (!prose) return 0;
    return prose.split(/[.!?…]+(?=\s|$)/).map(p => p.trim()).filter(Boolean).length;
}

/** De fase die per definitie geen einde krijgt. Zie `traceSpanOpen`. */
const OPEN_ENDED_STAGE = 'streaming_start';

/**
 * Stopt de klok van dit spoor bij het BEGIN van het antwoord?
 *
 * `streaming_start` krijgt nergens een tegenhanger: elke emitter is een kale
 * `emitPhase(...)` en de `emitPhaseEnd`-lijst kent die stage niet. De laatste
 * tik in het spoor is dus altijd het begin van het streamen, en de spanwijdte
 * stopt precies waar het antwoord begint — een beurt van twintig seconden kan
 * zo een pil van 300ms tonen boven vijf regels die wél over het antwoord gaan.
 *
 * Dat getal blijft staan (het is een echte meting van echte stappen), maar het
 * paneel moet er andere WOORDEN bij zetten: "tot het antwoord begon", niet
 * "tot de laatste stap". Vandaar deze aparte vraag in plaats van een
 * verzonnen eindtijd.
 */
export function traceSpanOpen(trail) {
    const rows = Array.isArray(trail) ? trail : [];
    let lastAt = null;
    let lastOpen = false;
    for (const r of rows) {
        if (!r) continue;
        for (const t of [r.startedAt, r.endedAt]) {
            if (!Number.isFinite(t)) continue;
            if (lastAt === null || t > lastAt) {
                lastAt = t;
                lastOpen = r.stage === OPEN_ENDED_STAGE && !Number.isFinite(r.endedAt);
            }
        }
    }
    return lastOpen;
}

/**
 * De spanwijdte van het spoor: van de eerste start tot de laatste tik.
 *
 * NIET de som van de duren — fases schuiven over elkaar heen (guardrails om
 * privacy_scan) en optellen telt de scan dan twee keer. Dit is ook niet "zo
 * lang duurde het antwoord": het is de tijd tussen de eerste en de laatste
 * opgetekende stap, en de UI moet dat zo benoemen — zie `traceSpanOpen` voor
 * het geval waarin die laatste stap het BEGIN van het antwoord is.
 */
export function traceSpanMs(trail) {
    const rows = Array.isArray(trail) ? trail : [];
    let first = null;
    let last = null;
    for (const r of rows) {
        if (!r) continue;
        for (const t of [r.startedAt, r.endedAt]) {
            if (!Number.isFinite(t)) continue;
            if (first === null || t < first) first = t;
            if (last === null || t > last) last = t;
        }
    }
    if (first === null || last === null || last <= first) return null;
    return last - first;
}

/**
 * Het hele spoor van één beurt.
 *
 * @param {object} msg  het assistent-bericht
 * @param {object} [opts]
 * @param {object} [opts.toolDecisions] { [argsKey]: 'approve'|'decline' } — wat
 *   er in deze sessie op een kaart geklikt is. Hierdoor werkt het spoor BIJ
 *   zodra een openstaande beslissing alsnog valt, zonder een nieuwe beurt.
 * @returns {{rows: Array, spanMs: number|null, spanOpen: boolean, tools: Array,
 *            isEmpty: boolean}}
 */
export function answerTraceFor(msg, { toolDecisions = {} } = {}) {
    const trail = Array.isArray(msg?.phaseTrail)
        ? msg.phaseTrail.filter(r => r && typeof r.stage === 'string')
        : [];
    const hasTrail = trail.length > 0;
    const rows = [
        questionRow(trail, hasTrail),
        sourcesRow(trail, msg, hasTrail),
        ruleRow(msg),
        heldActionRow(msg, toolDecisions),
        answerRow(trail, msg, hasTrail),
    ];
    return {
        rows,
        spanMs: traceSpanMs(trail),
        // Waar de klok stopte: bij de laatste afgesloten stap, of bij het
        // BEGIN van het antwoord. De UI zegt het verschil hardop.
        spanOpen: traceSpanOpen(trail),
        tools: toolStepsOf(msg),
        isEmpty: rows.every(r => r.state === 'missing'),
    };
}
