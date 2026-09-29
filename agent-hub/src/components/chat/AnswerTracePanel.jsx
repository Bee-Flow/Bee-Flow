/**
 * "Spoor van het laatste antwoord" — het blijvende paneel naast de testchat.
 *
 * Wélke regels hier mogen staan bepaalt `answerTrace.js`; dit bestand gaat
 * over de twee dingen die je op het scherm moet kunnen zien:
 *
 * ── 1. EEN ONTBREKENDE STAP IS ZICHTBAAR, MET DE REDEN ─────────────────────
 *
 * Het paneel toont altijd alle vijf de regels. Een regel die niet uit een echt
 * event op te maken is, verdwijnt niet stilletjes — hij staat er in gedempte
 * letters met de reden erbij. Dat is met opzet de lelijkere oplossing: een
 * spoor dat alleen zijn geslaagde stappen toont, leest als een compleet
 * verhaal, en dan is de afwezigheid van een stap niet te onderscheiden van een
 * stap die niet gemeten wordt.
 *
 * Elke reden gaat over de METING, nooit over de agent. Er staat "no knowledge
 * step was recorded", niet "the agent did not search" — dat laatste weten we
 * niet.
 *
 * ── 2. GEOORDEELD ZIET ER ANDERS UIT DAN OPGETEKEND ────────────────────────
 *
 * Vier regels komen van events die de server schreef terwijl het antwoord
 * gemaakt werd. De regelrij niet: die komt van een attributie-pass die ná
 * afloop de rol naast het antwoord legde. `AnswerChips.jsx` maakte daar al
 * vier dragers voor (vorm, woord, plaats, glyph) en het paneel houdt zich aan
 * dezelfde: gestippeld, een kopje "Judged" met de hele uitleg als
 * toegankelijke naam, en het ✨-teken dat in dit product "door een model
 * gemaakt" betekent. Hetzelfde onderscheid, dezelfde woorden, dezelfde
 * i18n-sleutels — twee panelen die het anders zeggen zijn twee beweringen.
 *
 * ── EEN BESLISSING DIE ALSNOG VALT, WERKT HET SPOOR BIJ ────────────────────
 *
 * Regel 4 gaat over een actie die is aangeboden en niet gestart. Dat is geen
 * eindtoestand: de gebruiker kan er alsnog ja op zeggen. Het paneel leest
 * daarom niet alleen `msg.pendingToolCalls` maar ook de beslissingen van deze
 * sessie (`toolDecisions`), via dezelfde lezing als de kaart zelf
 * (`toolConfirmStatus.js`). Klikken op de kaart werkt de regel dus meteen bij,
 * en hij zegt daarbij het eerlijke: een goedkeuring van de server betekent dat
 * de call gedraaid heeft, een klik van zojuist betekent dat hij bij het
 * volgende bericht gaat draaien.
 *
 * ── MONTAGE ────────────────────────────────────────────────────────────────
 *
 * Het paneel is zelfstandig en kent de chat niet. Wie het ophangt, geeft het
 * laatste assistent-bericht mee plus de sessiebeslissingen die `useChatEngine`
 * teruggeeft:
 *
 *     const { messages, toolDecisions } = useChatEngine({ testChat: { enabled: true } });
 *     <AnswerTracePanel
 *         msg={[...messages].reverse().find(m => m.role === 'assistant')}
 *         toolDecisions={toolDecisions}
 *     />
 *
 * Draaien: cd agent-hub && ./node_modules/.bin/vitest run src/components/chat/AnswerTracePanel.test.jsx
 */

import { Sparkles } from 'lucide-react';
import React from 'react';

import { answerTraceFor } from './answerTrace';
import ToolsUsedTimeline from './MessageItem/ToolsUsedTimeline';
import { DurationPill, StepBadge, TimelineRail } from './MessageItem/timelineParts';
import { nOf } from '../admin/Studio/KnowledgeStudio/plural';
import useTranslation from '../../hooks/useTranslation';

/** Regel-id → kop. De volgorde komt uit `answerTrace.js`, niet uit deze tabel. */
const ROW_TITLES = {
    question: { key: 'agent_studio.test.trace_row_question', en: 'Your question, read' },
    sources: { key: 'agent_studio.test.trace_row_sources', en: 'Knowledge consulted' },
    rule: { key: 'agent_studio.test.trace_row_rule', en: 'Rule kept to' },
    held_action: { key: 'agent_studio.test.trace_row_held', en: 'Action held for your decision' },
    answer: { key: 'agent_studio.test.trace_row_answer', en: 'Answer written' },
};

/**
 * Reden → zin. Elke zin gaat over wat er NIET GEMETEN is; geen van deze zinnen
 * mag te lezen zijn als een uitspraak over wat de agent deed of naliet.
 */
const MISSING_TEXT = {
    no_trace: { key: 'agent_studio.test.trace_missing_no_trace', en: 'No steps were recorded for this answer.' },
    not_recorded: { key: 'agent_studio.test.trace_missing_not_recorded', en: 'The run recorded no such step.' },
    not_reported: { key: 'agent_studio.test.trace_missing_not_reported', en: 'This step ran, but the number never came over the line.' },
    no_attribution: { key: 'agent_studio.test.trace_missing_no_attribution', en: 'No rule check ran for this answer, so there is nothing to attribute.' },
    not_measured: { key: 'agent_studio.test.trace_missing_not_measured', en: 'Nothing in this product measures this.' },
    no_prose: { key: 'agent_studio.test.trace_missing_no_prose', en: 'This answer has no prose to measure.' },
};

/** Weggelaten feit → hoe het heet in de "Not shown"-regel. */
const FACT_LABELS = {
    query: { key: 'agent_studio.test.trace_fact_query', en: 'search terms' },
    results: { key: 'agent_studio.test.trace_fact_results', en: 'number of results' },
    model: { key: 'agent_studio.test.trace_fact_model', en: 'model' },
    tone: { key: 'agent_studio.test.trace_fact_tone', en: 'tone' },
    language: { key: 'agent_studio.test.trace_fact_language', en: 'language' },
    sentences: { key: 'agent_studio.test.trace_fact_sentences', en: 'sentence count' },
};

/** Fase → waar die stap voor stond, zodat de lezer ziet waarop regel 1 rust. */
const STAGE_LABELS = {
    processed_history: { key: 'agent_studio.test.trace_stage_processed_history', en: 'conversation so far' },
    building_prompt: { key: 'agent_studio.test.trace_stage_building_prompt', en: 'prompt assembled' },
};

/** De stand van een vastgehouden actie → de zin erbij. */
function heldText(action, tt) {
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
 * Eén regel uit een tabel hierboven. De `{ key, en }`-vorm is geen smaak: de
 * i18n-guard vindt alleen zó de sleutels die als DATA reizen — een sleutel in
 * een array met de Engelse tekst ernaast is precies wat er bij O4 en W5 mis
 * ging, want de fallback laat het scherm er goed uitzien terwijl de sleutel
 * onvertaalbaar blijft. Dit bestand staat daarom in KEY_TABLE_FILES.
 */
const line = (tt, entry) => tt(entry.key, entry.en);

/** Eén gedempte regel per reden: welke feiten er ontbreken, en waarom. */
function OmittedNote({ omitted, tt }) {
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
                    className="text-[10px] mt-0.5"
                    style={{ color: 'var(--text-tertiary)' }}
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

/** De feiten van één opgetekende regel. */
function RowFacts({ row, tt }) {
    if (row.id === 'question') {
        const stages = (row.stages || [])
            .map(s => (STAGE_LABELS[s] ? line(tt, STAGE_LABELS[s]) : null))
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
        // ALLE zoektermen, niet de eerste. Twee kb_search-calls met
        // verschillende termen zijn twee zoekopdrachten, en de passages van
        // allebei stonden eerst onder één term geteld.
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
        // Tabelrijen tellen in hun eigen eenheid — zie sourcesRow: een rij die
        // op het moment van de vraag uit een tabel is gelezen is geen passage
        // uit een document.
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
                {row.actions.map(action => (
                    <div key={action.key} data-testid="trace-held" data-status={action.status}>
                        <div className="flex items-center gap-1.5 flex-wrap">
                            <code className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                                {action.toolName || '—'}
                            </code>
                            {action.effect === 'sends' && (
                                <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
                                    {tt('agent_studio.test.tool_effect_sends', 'leaves this workspace')}
                                </span>
                            )}
                        </div>
                        <div className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
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

/**
 * De geoordeelde regel. Eigen vorm, eigen kopje, eigen glyph — dezelfde vier
 * dragers als de chiprij, zodat het verschil een schermafdruk in grijstinten
 * en een schermlezer allebei overleeft.
 */
function JudgedFacts({ row, tt }) {
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
            <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide mb-0.5"
                style={{ color: 'var(--text-tertiary)' }}>
                <Sparkles className="w-2.5 h-2.5 shrink-0" strokeWidth={2} aria-hidden="true" />
                <span>{tt('agent_studio.answer_chips_judged', 'Judged')}</span>
            </div>
            {row.rules.map(({ rule }) => (
                <div key={rule} data-testid="trace-rule" className="text-[11px]"
                    style={{ color: 'var(--text-secondary)' }}>
                    {tt('agent_studio.chip_rule_followed', 'Rule followed: {rule}', { rule })}
                </div>
            ))}
        </div>
    );
}

function TraceRow({ row, n, tt }) {
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
                    {!isMissing && <DurationPill ms={row.ms} />}
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                    {isMissing
                        ? (
                            <span data-testid="trace-missing" data-reason={row.reason}
                                style={{ color: 'var(--text-tertiary)' }}>
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

const AnswerTracePanel = ({ msg = null, toolDecisions = {}, t = null, className = '' }) => {
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
                <span className="text-[11px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {tt('agent_studio.test.trace_title', 'Trace of the last answer')}
                </span>
                {trace && (
                    // De hint hangt af van WAAR de klok stopte. `streaming_start`
                    // krijgt nooit een einde, dus bij een normale beurt is de
                    // laatste tik het BEGIN van het antwoord — en dan is dit
                    // getal de voorbereidingstijd, niet de beurtduur. Dat mag
                    // niet in een algemene zin verdwijnen boven vijf regels die
                    // wél over het antwoord gaan.
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
            <p className="text-[10px] mb-2" style={{ color: 'var(--text-tertiary)' }}>
                {tt('agent_studio.test.trace_subtitle',
                    'Only what the run recorded. A step that is missing says why.')}
            </p>

            {!trace ? (
                <p className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
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

                    {/* Dezelfde tijdlijn als in "How I got this answer" — de
                        tools die deze beurt echt draaide. Apart ingeklapt, want
                        het is een tweede lijst met een eigen nummering. */}
                    {trace.tools.length > 0 && (
                        <details className="mt-2">
                            <summary
                                className="text-[10px] cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden"
                                style={{ color: 'var(--text-tertiary)' }}
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
