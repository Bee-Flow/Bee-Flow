/**
 * The TRAIL of the last answer: which rules may stand there, and which are
 * missing because nobody measured them.
 *
 * ── THE DESIGN ASKED FOR FIVE RULES. FOUR CAN BE MEASURED ───────────────────
 *
 * The panel shows five steps: the question read, a source consulted, a rule
 * applied, an action offered but not started, and the answer written. Each rule
 * had to be set here against the EVENTS the server actually sends, and that did
 * not work out everywhere. What is there:
 *
 *   1 question     `phase processed_history` + `phase building_prompt`
 *                  (chatStream.js). Measures that the turn read the question and
 *                  built a prompt from it, NOT that it understood it. That is why
 *                  this rule is called "read" and not "understood": understanding
 *                  measures nothing in this product, and a trail that claims
 *                  understanding is exactly the reassurance this panel should
 *                  combat.
 *   2 source       `phase kb_search` (the auto-injection) and/or a `kb_search`
 *                  tool call in `toolHistory`, plus the passages from `kb_sources`.
 *   3 rule         the attribution pass (`rule_attribution`). JUDGED, not minutes.
 *                  See below.
 *   4 action       `tool_confirm` with the status from `toolConfirmStatus.js`.
 *   5 answer       `phase streaming_start` (with the model as detail) and the
 *                  answer itself.
 *
 * ── AND WHAT IS NOT THERE, WITH THE REASON ─────────────────────────────────
 *
 * TONE and LANGUAGE. The design wanted them at rule 5. `persona.tone.chips` and
 * `persona.language` do exist (personaPrompt.js), but that is what was REQUESTED,
 * the role the builder typed. Nobody measures whether the answer hit that tone,
 * and nothing in the event stream carries the language of the answer. Putting them
 * beside the measured rules would turn a wish into a result. So they stand in
 * `omitted`, with a reason, and never as fact.
 *
 * THE NUMBER OF RESULTS, sometimes. `kb_sources` only goes over the line if the
 * agent has `includeSourceReferences` on (knowledgeSearch.js), and the project-KB
 * injection never sends it (contextEnrichment.js), which only persists. A search
 * step without passages therefore means "we do not know", not "zero found". That
 * is why the count is then `null` with reason `not_reported`. A 0 is never shown
 * where nobody has counted.
 *
 * THE SEARCH TERMS, on the automatic path. The auto-injection searches without
 * sending anything of its search query. Only the kb_search TOOL carries
 * `args.query`. No query in the trail means `omitted`, no guess.
 *
 * ── RECORDED AND JUDGED STAY SEPARATE ─────────────────────────────────────
 *
 * Rule 3 comes from a second model that afterwards laid the role next to the
 * answer. That is an OPINION. `answerChips.js` already made two kinds of claim out
 * of that ('recorded' / 'judged'), and that vocabulary applies here unchanged. The
 * rule row carries `state: 'judged'`, and the render must keep it apart in form
 * and place. Mixing them gives the weakest claim in the panel the authority of the
 * strongest.
 *
 * ── A MISSING RULE CLAIMS NOTHING ABOUT THE AGENT ──────────────────────────
 *
 * "No knowledge step recorded" is a statement about the MEASUREMENT, not about what
 * the agent did. That difference is in the words of every reason below, and it is
 * the reason that no reason exists which says "the agent did not search". We do
 * not know that.
 *
 * Pure: no React, no t(), no DOM. So that "which rule may appear here" can be
 * tested with plain objects.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/chat/answerTrace.test.js
 */

import { ruleChipsOf } from './MessageItem/answerChips';
import { documentCountOf } from './MessageItem/citationGroups';
import { confirmDecisionOf, type ConfirmBook } from './MessageItem/toolConfirmStatus';
import type { AnswerRow, HeldAction, HeldActionRow, MissingRow, OmittedFact, PhaseTrailEntry, QuestionRow, RuleRow, SourcesRow, ToolConfirmCall, ToolEntry, ToolTimes, TraceMessage, TraceRow, TraceSource } from './answerTrace.types';

/** De vijf regels, in leesvolgorde. */
const TRACE_ROWS = Object.freeze(['question', 'sources', 'rule', 'held_action', 'answer']);

/** De drie standen van een regel. 'judged' is er precies één: de attributie. */
const TRACE_STATES = Object.freeze(['recorded', 'judged', 'missing']);

/**
 * Waarom een regel ontbreekt. Gesloten lijst — elke reden krijgt één zin in de
 * UI, en elke zin gaat over de meting, nooit over de agent.
 */
const MISSING_REASONS = Object.freeze([
    /** Nothing has been recorded for this turn (e.g. a reloaded conversation). */
    'no_trace',
    /** Something has been recorded, but a step like that was not among it. */
    'not_recorded',
    /** The step ran, but this number never came over the line. */
    'not_reported',
    /** De extra regelcontrole draaide niet, of vond niets om te melden. */
    'no_attribution',
    /** Niets in dit product meet dit. */
    'not_measured',
    /** There was no prose to measure (e.g. an answer that is only code). */
    'no_prose',
]);

/** De feiten die per regel weggelaten kunnen zijn. Gesloten lijst. */
const OMITTED_FACTS = Object.freeze([
    'query', 'results', 'model', 'tone', 'language', 'sentences',
]);

/** Citations from a LIVE table row. No document, no passage. See sourcesRow. */
const TABLE_ROW_KIND = 'datatable_row';

/** De fases die samen "de vraag is ingelezen" opleveren. */
const QUESTION_STAGES = Object.freeze(['processed_history', 'building_prompt']);

/** The tool name with which an agent searches its own knowledge base. */
const KB_TOOL = 'kb_search';

/** As `HowIGotThisAnswer` counts: the thinking steps are not a tool. */
const HIDDEN_TOOL = 'sequentialthinking';

/** A table with neither a name nor a heading still counts as one table. */
const UNKNOWN_DOC = 'Unknown Source';

// ── Kleine hulpjes ───────────────────────────────────────────────────

function text(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

function missing(id: string, reason: string): MissingRow {
    return { id, state: 'missing', reason, omitted: [] };
}

/**
 * The durations of a series of steps added together.
 *
 * Only to be used on steps that FOLLOW EACH OTHER. Phases that slide over each
 * other (guardrails around privacy_scan) would be counted twice by this. For that
 * there is `traceSpanMs`.
 */
function sumDurations(steps: Array<{ durationMs?: number | null } | null | undefined>) {
    let total = null;
    for (const s of steps) {
        if (!s || !Number.isFinite(s.durationMs)) continue;
        total = (total || 0) + (s.durationMs as number);
    }
    return total;
}

/** De tools die deze beurt draaide, zoals "How I got this answer" ze telt. */
function toolStepsOf(msg: TraceMessage | null | undefined): ToolEntry[] {
    const history = Array.isArray(msg?.toolHistory) ? msg.toolHistory : [];
    return history.filter((t: ToolEntry | null) => t && t.name !== HIDDEN_TOOL);
}

/** The duration of a tool call, from its own clock ticks. */
function toolDurationMs(tool: ToolEntry | null | undefined) {
    return Number.isFinite(tool?.endTime) && Number.isFinite(tool?.startTime)
        ? (tool as ToolTimes).endTime - (tool as ToolTimes).startTime
        : null;
}

// ── De vijf regels ───────────────────────────────────────────────────

/** 1: the question was read and turned into a prompt. Not: understood. */
function questionRow(trail: PhaseTrailEntry[], hasTrail: boolean): QuestionRow | MissingRow {
    const steps = trail.filter((r: PhaseTrailEntry) => QUESTION_STAGES.includes(r.stage));
    if (steps.length === 0) return missing('question', hasTrail ? 'not_recorded' : 'no_trace');
    return {
        id: 'question',
        state: 'recorded',
        // The stages are listed so that the reader sees WHAT this rule rests on.
        stages: steps.map((s: PhaseTrailEntry) => s.stage),
        ms: sumDurations(steps),
        omitted: [],
    };
}

/**
 * 2: the knowledge base was searched, with what, and how much it yielded.
 *
 * ── A TABLE ROW IS NOT A DOCUMENT ─────────────────────────────────────────
 *
 * `msg.kbSources` carries TWO kinds of citation through the same event. A
 * `kb_chunk` is a passage from a document. A `datatable_row` is one row that was
 * read from a table at the moment of the question, with the ROW NAME as its title.
 * Counting them together as "passages from documents" gave, for three table rows,
 * literally "3 passages from 3 documents". One table was read, not three documents,
 * and no knowledge base was consulted. `answerChips.js` already makes that
 * distinction explicit. Here it did not apply, and then two panels on the same
 * message say something different about the same event.
 */
function sourcesRow(trail: PhaseTrailEntry[], msg: TraceMessage | null | undefined, hasTrail: boolean): SourcesRow | MissingRow {
    const phases = trail.filter((r: PhaseTrailEntry) => r.stage === KB_TOOL);
    const toolCalls = toolStepsOf(msg).filter((t: ToolEntry) => t.name === KB_TOOL);
    const sources: TraceSource[] = Array.isArray(msg?.kbSources) ? msg.kbSources.filter(Boolean) : [];
    const passages = sources.filter((s: TraceSource) => s.kind !== TABLE_ROW_KIND);
    const tableRows = sources.filter((s: TraceSource) => s.kind === TABLE_ROW_KIND);

    if (phases.length === 0 && toolCalls.length === 0 && sources.length === 0) {
        const knowsSomething = hasTrail || toolStepsOf(msg).length > 0;
        return missing('sources', knowsSomething ? 'not_recorded' : 'no_trace');
    }

    // Only the tool carries its search query. The auto-injection sends none.
    // ALL terms, not just the first: several kb_search calls in one turn are the
    // normal course of events on the agent path, and the second term used to be
    // left out without a word, while the passages of both searches were counted
    // under that one term.
    const queries = [...new Set(toolCalls.map((t: ToolEntry) => text(t.args?.query)).filter(Boolean))];
    const query = queries[0] || null;
    // Zero passages here is NOT zero results. See the heading.
    const results = passages.length > 0 ? passages.length : null;
    // Counted the way the sources panel and the chip row group them
    // (citationGroups.ts), so the three never disagree (BFSF-352).
    const documents = results ? documentCountOf(passages) : null;
    // De tabelhelft telt in zijn eigen eenheid: rijen, uit tabellen.
    const rows = tableRows.length > 0 ? tableRows.length : null;
    const tables = rows
        ? new Set(tableRows.map((s: TraceSource) => text(s.sourceName) || text(s.section) || UNKNOWN_DOC)).size
        : null;
    const ms = phases.length > 0
        ? sumDurations(phases)
        : sumDurations(toolCalls.map((t: ToolEntry) => ({ durationMs: toolDurationMs(t) })));

    // Something about the KNOWLEDGE BASE is only to be reported if there was also a
    // knowledge-base step. A turn that only read a table leaves no passages out.
    // It has none.
    const hadKbStep = phases.length > 0 || toolCalls.length > 0 || passages.length > 0;
    const omitted = [];
    if (hadKbStep && queries.length === 0) omitted.push({ fact: 'query', reason: 'not_recorded' });
    if (hadKbStep && results === null) omitted.push({ fact: 'results', reason: 'not_reported' });

    return {
        id: 'sources', state: 'recorded',
        query, queries, results, documents, rows, tables, ms, omitted,
    };
}

/** 3: which rule of the role this answer followed. JUDGED, not minutes. */
function ruleRow(msg: TraceMessage | null | undefined): RuleRow | MissingRow {
    const rules = ruleChipsOf(msg);
    if (rules.length === 0) return missing('rule', 'no_attribution');
    return { id: 'rule', state: 'judged', rules, omitted: [] };
}

/** 4 — een actie die is aangeboden, en wat er daarna mee gebeurd is. */
function heldActionRow(msg: TraceMessage | null | undefined, decided: ConfirmBook): HeldActionRow | MissingRow {
    const calls = Array.isArray(msg?.pendingToolCalls)
        ? msg.pendingToolCalls.filter((c: ToolConfirmCall | null) => c && typeof c === 'object')
        : [];
    // No `no_trace` here: held calls do not hang on the phase trail, so the absence
    // says the same whether or not there is a trail.
    if (calls.length === 0) return missing('held_action', 'not_recorded');

    const actions = calls.map((call: ToolConfirmCall, i: number): HeldAction => {
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
        openCount: actions.filter((a: HeldAction) => a.status === 'pending').length,
        omitted: [],
    };
}

/** 5 — het antwoord is geschreven: door welk model, en hoe lang het werd. */
function answerRow(trail: PhaseTrailEntry[], msg: TraceMessage | null | undefined, hasTrail: boolean): AnswerRow | MissingRow {
    const streaming = [...trail].reverse().find((r: PhaseTrailEntry) => r.stage === 'streaming_start') || null;
    const content = typeof msg?.content === 'string' ? msg.content : '';
    if (!streaming && !content) return missing('answer', hasTrail ? 'not_recorded' : 'no_trace');

    const model = streaming ? text(streaming.detail) : null;
    const omitted: OmittedFact[] = [];
    if (!model) omitted.push({ fact: 'model', reason: 'not_recorded' });
    // De twee die het ontwerp vroeg en die niemand meet. Zie de kop.
    omitted.push({ fact: 'tone', reason: 'not_measured' });
    omitted.push({ fact: 'language', reason: 'not_measured' });

    // The guard belongs on the PROSE, not on the content. `content` may be filled with
    // nothing but a code block. `countSentences` cut that out first and then returned
    // 0, and then "Written by … · 0 sentences" stood under an answer that does contain
    // text. That is precisely the 0 where "not counted" belongs, which the heading of
    // this file forbids.
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
 * How many sentences the answer counts.
 *
 * Arithmetic on the text that is delivered, not a statement about the text. The
 * rule: a sentence ends in `. ! ? …` followed by whitespace or the end. Thus
 * `3.5 percent` does not count as two sentences (the full stop is followed by a
 * digit), and neither does `foo.bar()`.
 *
 * Code blocks come out first. A block of JavaScript is full of full stops and would
 * blow the number up wildly, and a code block is in any case not prose.
 *
 * It stays approximate for abbreviations ("e.g.", "Mr.") and for an ellipsis in the
 * middle of a sentence. It is a count of the delivery, not of the meaning.
 */
export function countSentences(text_?: unknown) {
    const raw = typeof text_ === 'string' ? text_ : '';
    const prose = raw
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`\n]*`/g, ' ')
        .trim();
    if (!prose) return 0;
    return prose.split(/[.!?…]+(?=\s|$)/).map((p: string) => p.trim()).filter(Boolean).length;
}

/** De fase die per definitie geen einde krijgt. Zie `traceSpanOpen`. */
const OPEN_ENDED_STAGE = 'streaming_start';

/**
 * Does the clock of this trail stop at the START of the answer?
 *
 * `streaming_start` has no counterpart anywhere. Every emitter is a bare
 * `emitPhase(...)`, and the `emitPhaseEnd` list does not know that stage. The last
 * tick in the trail is therefore always the start of streaming, and the span stops
 * exactly where the answer begins. A turn of twenty seconds can thus show a pill of
 * 300 ms above five rows that DO concern the answer.
 *
 * That number stays, because it is a real measurement of real steps, but the panel
 * must put other WORDS next to it: "until the answer began", not "until the last
 * step". Hence this separate question instead of an invented end time.
 */
function traceSpanOpen(trail: unknown) {
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
 * The span of the trail: from the first start to the last tick.
 *
 * NOT the sum of the durations. Phases slide over each other (guardrails around
 * privacy_scan), and adding them would count the scan twice. Nor is this "how long
 * the answer took". It is the time between the first and the last recorded step,
 * and the UI must name it that way. See `traceSpanOpen` for the case in which that
 * last step is the START of the answer.
 */
export function traceSpanMs(trail: unknown) {
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
 * The whole trail of one turn.
 *
 * @param {object} msg  the assistant message
 * @param {object} [opts.toolDecisions] { [argsKey]: 'approve'|'decline' }: what
 *   has been clicked on a card in this session. Thereby the trail updates WHEN an
 *   open decision falls, without a new turn.
 */
export function answerTraceFor(msg: TraceMessage | null | undefined, { toolDecisions = {} }: { toolDecisions?: ConfirmBook } = {}) {
    const trail: PhaseTrailEntry[] = Array.isArray(msg?.phaseTrail)
        ? msg.phaseTrail.filter((r: PhaseTrailEntry | null) => r && typeof r.stage === 'string')
        : [];
    const hasTrail = trail.length > 0;
    const rows: TraceRow[] = [
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
        isEmpty: rows.every((r: TraceRow) => r.state === 'missing'),
    };
}
