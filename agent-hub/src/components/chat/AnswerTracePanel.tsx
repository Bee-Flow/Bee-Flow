/**
 * "Trace of the last answer": the persistent panel next to the test chat.
 *
 * WHICH lines may stand here is decided by `answerTrace.js`. This file concerns the two things you
 * must be able to see on screen:
 *
 * ── 1. A MISSING STEP IS VISIBLE, WITH THE REASON ──────────────────────────
 *
 * The panel always shows all five lines. A line that cannot be derived from a real event does not
 * disappear silently: it stands there in muted letters with the reason beside it. That is
 * deliberately the uglier solution. A trace that shows only its successful steps reads as a complete
 * story, and then the absence of a step is not distinguishable from a step that is not measured.
 *
 * Every reason concerns the MEASUREMENT, never the agent. It says "no knowledge step was recorded",
 * not "the agent did not search", because the latter we do not know.
 *
 * ── 2. JUDGED LOOKS DIFFERENT FROM RECORDED ──────────────────────────────
 *
 * Four lines come from events that the server wrote while the answer was being made. The line about
 * the attribution pass is not one of them: that comes from an attribution pass that placed the role
 * next to the answer afterwards. `AnswerChips.jsx` already made four carriers for that (shape, word,
 * place, glyph), and the panel keeps to the same ones: dotted, a heading "Judged" with the whole
 * explanation as the accessible name, and the ✨ sign that in this product means "written by a model".
 * The same distinction, the same words, the same i18n keys. Two panels that say it differently are two claims.
 *
 * ── A DECISION THAT STILL FALLS, THE TRACE UPDATES ────────────────────────
 *
 * Line 4 concerns an action that has been offered and not started. That is not a final state: the
 * user can still say yes to it. The panel therefore reads not only `msg.pendingToolCalls` but also the
 * decisions of this session (`toolDecisions`), through the same reading as the card itself
 * (`toolConfirmStatus.js`). Clicking the card therefore updates the line at once, and it says the
 * honest thing: an approval from the server means the call has run, a click just now means it will run
 * with the next message.
 *
 * ── MOUNTING ────────────────────────────────────────────────────────────
 *
 * The panel is self-contained and does not know the chat. Whoever hangs it up passes the last assistant
 * message along, plus the session decisions that `useChatEngine` returns:
 *
 *     const { messages, toolDecisions } = useChatEngine({ testChat: { enabled: true } });
 *     <AnswerTracePanel
 *         msg={[...messages].reverse().find(m => m.role === 'assistant')}
 *         toolDecisions={toolDecisions}
 *     />
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/chat/AnswerTracePanel.test.jsx
 */

import { Sparkles } from 'lucide-react';

import { answerTraceFor } from './answerTrace';
import ToolsUsedTimeline from './MessageItem/ToolsUsedTimeline';
import { DurationPill, StepBadge, TimelineRail } from './MessageItem/timelineParts';
import { nOf } from '../admin/Studio/KnowledgeStudio/plural';
import useTranslation from '../../hooks/useTranslation';
import type { HeldAction, HeldActionRow, OmittedFact, QuestionRow, RuleRow, SourcesRow, AnswerRow, TraceMessage, TraceRow as TraceRowData } from './answerTrace.types';
import type { TranslateParams } from '../../hooks/useTranslation';
import type { OmittedNoteProps, RowFactsProps, JudgedFactsProps, TraceRowProps, AnswerTracePanelProps } from './AnswerTracePanel.types';

/** Rule id → heading. The order comes from `answerTrace.js`, not from this table. */
const ROW_TITLES: Record<string, { key: string; en: string; }> = {
    question: { key: 'agent_studio.test.trace_row_question', en: 'Your question, read' },
    sources: { key: 'agent_studio.test.trace_row_sources', en: 'Knowledge consulted' },
    rule: { key: 'agent_studio.test.trace_row_rule', en: 'Rule kept to' },
    held_action: { key: 'agent_studio.test.trace_row_held', en: 'Action held for your decision' },
    answer: { key: 'agent_studio.test.trace_row_answer', en: 'Answer written' },
};

/**
 * Reason → sentence. Every sentence concerns what was NOT MEASURED. None of these sentences may
 * be readable as a statement about what the agent did or failed to do.
 */
const MISSING_TEXT: Record<string, { key: string; en: string; }> = {
    no_trace: { key: 'agent_studio.test.trace_missing_no_trace', en: 'No steps were recorded for this answer.' },
    not_recorded: { key: 'agent_studio.test.trace_missing_not_recorded', en: 'The run recorded no such step.' },
    not_reported: { key: 'agent_studio.test.trace_missing_not_reported', en: 'This step ran, but the number never came over the line.' },
    no_attribution: { key: 'agent_studio.test.trace_missing_no_attribution', en: 'No rule check ran for this answer, so there is nothing to attribute.' },
    not_measured: { key: 'agent_studio.test.trace_missing_not_measured', en: 'Nothing in this product measures this.' },
    no_prose: { key: 'agent_studio.test.trace_missing_no_prose', en: 'This answer has no prose to measure.' },
};

/** Weggelaten feit → hoe het heet in de "Not shown"-regel. */
const FACT_LABELS: Record<string, { key: string; en: string; }> = {
    query: { key: 'agent_studio.test.trace_fact_query', en: 'search terms' },
    results: { key: 'agent_studio.test.trace_fact_results', en: 'number of results' },
    model: { key: 'agent_studio.test.trace_fact_model', en: 'model' },
    tone: { key: 'agent_studio.test.trace_fact_tone', en: 'tone' },
    language: { key: 'agent_studio.test.trace_fact_language', en: 'language' },
    sentences: { key: 'agent_studio.test.trace_fact_sentences', en: 'sentence count' },
};

/** Fase → waar die stap voor stond, zodat de lezer ziet waarop regel 1 rust. */
const STAGE_LABELS: Record<string, { key: string; en: string; }> = {
    processed_history: { key: 'agent_studio.test.trace_stage_processed_history', en: 'conversation so far' },
    building_prompt: { key: 'agent_studio.test.trace_stage_building_prompt', en: 'prompt assembled' },
};

/** De stand van een vastgehouden actie → de zin erbij. */
function heldText(action: HeldAction, tt: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) {
    if (action.status === 'approved') {
        // De herkomst is het verschil tussen "heeft gedraaid" en "gaat
        // draaien"; zie toolConfirmStatus.js.
        return action.by === 'session'
            ? tt('agent_studio.test.tool_confirm_approved_next', 'You approved this — it runs on your next message')
            : tt('agent_studio.test.tool_confirm_approved', 'You approved this — it ran');
    }
    if (action.status === 'declined') {
        return tt('agent_studio.test.tool_confirm_declined', 'You declined this — it did not run');
    }
    if (action.status === 'unknown') {
        return tt('agent_studio.test.tool_confirm_unknown', 'Could not tell whether this ran');
    }
    return tt('agent_studio.test.trace_held_pending', 'Offered, not started');
}

/**
 * One row from a table above. The `{ key, en }` shape is no matter of taste: the i18n guard finds
 * the keys that travel as DATA only this way. A key in an array with the English text beside it is
 * exactly what went wrong at O4 and W5, because the fallback makes the screen look right while the
 * key stays untranslatable. This file is therefore in KEY_TABLE_FILES.
 */
const line = (tt: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string, entry: { key: string; en: string }) => tt(entry.key, entry.en);

function OmittedNote({ omitted, tt }: OmittedNoteProps) {
    if (!omitted || omitted.length === 0) return null;
    const byReason = new Map();
    for (const { fact, reason } of omitted) {
        if (!FACT_LABELS[fact] || !MISSING_TEXT[reason]) continue;
        if (!byReason.has(reason)) byReason.set(reason, []);
        byReason.get(reason).push(line(tt, FACT_LABELS[fact]));
    }
    if (byReason.size === 0) return null;
    return (
        <>
            {[...byReason.entries()].map(([reason, facts]) => (
                <div
                    key={reason}
                    data-testid="trace-omitted"
                    data-reason={reason}
                    className="text-[10px] mt-0.5 text-[var(--text-tertiary)]"
                >
                    {tt('agent_studio.test.trace_omitted', 'Not shown: {facts} — {reason}', {
                        facts: facts.join(', '),
                        reason: line(tt, MISSING_TEXT[reason]),
                    })}
                </div>
            ))}
        </>
    );
}

function RowFacts({ row, tt }: RowFactsProps) {
    if (row.id === 'question') {
        const stages = (row.stages || [])
            .map((s: string): string | null => (STAGE_LABELS[s] ? line(tt, STAGE_LABELS[s]) : null))
            .filter(Boolean);
        return (
            <span data-testid="trace-fact">
                {stages.length > 0
                    ? stages.join(' · ')
                    : tt('agent_studio.test.trace_question_read', 'Read and turned into a prompt')}
            </span>
        );
    }

    if (row.id === 'sources') {
        const bits = [];
        // ALL search terms, not just the first. Two kb_search calls with different terms are two
        // searches, and the passages of both were first counted under one term.
        const queries = Array.isArray(row.queries) ? row.queries : (row.query ? [row.query] : []);
        for (const q of queries) {
            bits.push(tt('agent_studio.test.trace_query', 'Searched for “{query}”', { query: q }));
        }
        if (row.results !== null) {
            const passages = nOf(tt, 'agent_studio.test.trace_passages', row.results,
                '{count} passage', '{count} passages');
            const docs = row.documents
                ? nOf(tt, 'agent_studio.test.trace_documents', row.documents,
                    'from {count} document', 'from {count} documents')
                : null;
            bits.push(docs ? `${passages} ${docs}` : passages);
        }
        // Table rows count in their own unit (see sourcesRow): a row that was read from a table at the
        // moment of the question is not a passage from a document.
        if (row.rows) {
            const rowsText = nOf(tt, 'agent_studio.test.trace_table_rows', row.rows,
                '{count} table row', '{count} table rows');
            const tablesText = row.tables
                ? nOf(tt, 'agent_studio.test.trace_tables', row.tables,
                    'from {count} table', 'from {count} tables')
                : null;
            bits.push(tablesText ? `${rowsText} ${tablesText}` : rowsText);
        }
        return <span data-testid="trace-fact">{bits.join(' · ')}</span>;
    }

    if (row.id === 'held_action') {
        return (
            <div className="space-y-1">
                {row.actions.map((action: HeldAction) => (
                    <div key={action.key} data-testid="trace-held" data-status={action.status}>
                        <div className="flex items-center gap-1.5 flex-wrap">
                            <code className="text-[11px] font-semibold text-[var(--text-primary)]">
                                {action.toolName || '—'}
                            </code>
                            {action.effect === 'sends' && (
                                <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
                                    {tt('agent_studio.test.tool_effect_sends', 'leaves this workspace')}
                                </span>
                            )}
                        </div>
                        <div className="text-[11px] text-[var(--text-secondary)]">
                            {heldText(action, tt)}
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (row.id === 'answer') {
        const bits = [];
        if (row.model) bits.push(tt('agent_studio.test.trace_model', 'Written by {model}', { model: row.model }));
        if (row.sentences !== null) {
            bits.push(nOf(tt, 'agent_studio.test.trace_sentences', row.sentences,
                '{count} sentence', '{count} sentences'));
        }
        return <span data-testid="trace-fact">{bits.join(' · ')}</span>;
    }

    return null;
}

function JudgedFacts({ row, tt }: JudgedFactsProps) {
    const hint = tt(
        'agent_studio.answer_chips_judged_hint',
        'An extra check read your rules and this answer afterwards. This is its opinion, not something the run recorded.',
    );
    return (
        <div
            className="rounded-lg px-2 py-1.5"
            style={{ border: '1px dashed var(--border-subtle)', background: 'transparent' }}
            aria-label={hint}
            title={hint}
            data-testid="trace-judged"
        >
            <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide mb-0.5 text-[var(--text-tertiary)]">
                <Sparkles className="w-2.5 h-2.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                <span>{tt('agent_studio.answer_chips_judged', 'Judged')}</span>
            </div>
            {row.rules.map(({ rule }) => (
                <div key={rule} data-testid="trace-rule" className="text-[11px] text-[var(--text-secondary)]">
                    {tt('agent_studio.chip_rule_followed', 'Rule followed: {rule}', { rule })}
                </div>
            ))}
        </div>
    );
}

function TraceRow({ row, n, tt }: TraceRowProps) {
    const isMissing = row.state === 'missing';
    return (
        <li
            className="relative flex gap-2.5"
            data-testid="trace-row"
            data-row={row.id}
            data-state={row.state}
        >
            <StepBadge n={n} muted={isMissing} />
            <div className="flex-1 min-w-0 pb-2">
                <div className="flex items-center gap-2">
                    <span
                        className="text-[11px] font-semibold"
                        style={{ color: isMissing ? 'var(--text-tertiary)' : 'var(--text-primary)' }}
                    >
                        {line(tt, ROW_TITLES[row.id])}
                    </span>
                    {!isMissing && <DurationPill ms={(row as QuestionRow | SourcesRow).ms} />}
                </div>
                <div className="text-[11px] mt-0.5 text-[var(--text-secondary)]">
                    {isMissing
                        ? (
                            <span data-testid="trace-missing" data-reason={row.reason}
                                className="text-[var(--text-tertiary)]">
                                {line(tt, MISSING_TEXT[row.reason])}
                            </span>
                        )
                        : row.state === 'judged'
                            ? <JudgedFacts row={row} tt={tt} />
                            : <RowFacts row={row} tt={tt} />}
                </div>
                <OmittedNote omitted={row.omitted} tt={tt} />
            </div>
        </li>
    );
}

const AnswerTracePanel = ({ msg = null, toolDecisions = {}, t = null, className = '' }: AnswerTracePanelProps) => {
    const { t: tFallback } = useTranslation();
    const tt = t || tFallback;
    const trace = msg ? answerTraceFor(msg, { toolDecisions }) : null;

    return (
        <aside
            data-testid="answer-trace"
            className={`rounded-xl p-3 ${className}`}
            style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
            aria-label={tt('agent_studio.test.trace_title', 'Trace of the last answer')}
        >
            <div className="flex items-center gap-2 mb-2">
                <span className="text-[11px] font-semibold text-[var(--text-primary)]">
                    {tt('agent_studio.test.trace_title', 'Trace of the last answer')}
                </span>
                {trace && (
                    // The hint depends on WHERE the clock stopped. `streaming_start` never gets an end, so on a
                    // normal turn the last tick is the BEGINNING of the answer, and then this number is the
                    // preparation time, not the turn duration. That may not disappear into a general sentence
                    // above five lines that DO concern the answer.
                    <DurationPill
                        ms={trace.spanMs}
                        title={trace.spanOpen
                            ? tt('agent_studio.test.trace_span_hint_open',
                                'Time from the first recorded step until the answer started — the writing itself is not timed')
                            : tt('agent_studio.test.trace_span_hint',
                                'Time between the first and the last recorded step')}
                    />
                )}
            </div>
            <p className="text-[10px] mb-2 text-[var(--text-tertiary)]">
                {tt('agent_studio.test.trace_subtitle',
                    'Only what the run recorded. A step that is missing says why.')}
            </p>

            {!trace ? (
                <p className="text-[11px] text-[var(--text-tertiary)]">
                    {tt('agent_studio.test.trace_none', 'Ask something to see how the answer was made.')}
                </p>
            ) : (
                <>
                    <div className="relative">
                        <TimelineRail show={trace.rows.length > 1} />
                        <ol className="space-y-1">
                            {trace.rows.map((row, i) => (
                                <TraceRow key={row.id} row={row} n={i + 1} tt={tt} />
                            ))}
                        </ol>
                    </div>

                    {/* The same timeline as in "How I got this answer": the tools that this turn really ran.
                        Collapsed separately, because it is a second list with its own numbering. */}
                    {trace.tools.length > 0 && (
                        <details className="mt-2">
                            <summary
                                className="text-[10px] cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden text-[var(--text-tertiary)]"
                            >
                                {tt('agent_studio.test.trace_tools', 'Tools this answer ran')}
                            </summary>
                            <div className="mt-2">
                                <ToolsUsedTimeline visibleTools={trace.tools} />
                            </div>
                        </details>
                    )}
                </>
            )}
        </aside>
    );
};

export default AnswerTracePanel;
