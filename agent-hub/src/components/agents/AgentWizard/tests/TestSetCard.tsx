import { AlertTriangle, Ban, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, FlaskConical, Play, Plus, XCircle, type LucideIcon } from 'lucide-react';
import React, { useState } from 'react';
import {
    PROGRESS, REFUSAL, RUN_STATE,
    firstProblem, justRanScore, problemFor, summariseRun,
    type AgentTest, type Refusal, type RunProgress, type RunSummary, type TestItem, type TestRun,
} from './testSetFacts';
import { nOf } from '../../../admin/Studio/KnowledgeStudio/plural';
import { EmptyRow, UnreadableNotice } from '../canUse/CanUseCard';
import { READ } from '../canUse/canUseFacts';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { RelativeTimeInput } from '../../../../hooks/useRelativeTime';
import type { StatusDotProps, RefusalNoticeProps, ScoreLineProps, AboutLineProps, FailLineProps, TestRowProps, TestSetCardProps } from './TestSetCard.types';

/**
 * The test-set card of the Test tab (Agents artboard 1c, A4 part D).
 *
 * Four things, and three of them are there to prevent the card from claiming something it
 * does not know:
 *
 *   THE COUNT    "11 / 12 passed" is a result of ONE RUN. Never run is not "0 / 12"
 *                (nothing was asked), a read that failed is not that either, and a run
 *                that fell over halfway is not a result. `testSetFacts.summariseRun`
 *                decides which of the four it is; this card only writes the sentence.
 *   THE FAILURE  the one non-green result, with WHY. `fail`, `blocked` and `error` are
 *                three different things and get three different sentences: only the
 *                first says something about the agent.
 *   VIEW         the questions with their latest verdict, plus the run history, because
 *                one number without history turns a chance green run into a fact.
 *   + THIS CHAT AS TEST
 *                the button that makes a test from the last turn. It appears only if
 *                there IS a turn; a button that has nowhere to go is worse than no button.
 *
 * ── A REFUSAL IS NOT A FAILED TEST ──────────────────────────────────
 * "No model is set up to judge these answers" comes back before even one turn has run
 * (`POST /:id/tests/run` refuses with 503). That refusal is drawn here as a refusal and
 * leaves the count alone. If it landed as red tests, someone would go and repair his
 * agent while nothing is wrong with the agent, and that is exactly the kind of false red
 * that teaches people to ignore the test set.
 *
 * ── READ-ONLY REMOVES THE ACTIONS, AND THE SERVER THE FACTS ────────
 * `ro` hides Run and "+ Dit gesprek als test" (BFSF-271: read-only removes the EDITING
 * affordances). The count, the failure line and View remain, AS LONG AS the read succeeds.
 *
 * And that does not succeed today for someone who may only view: every route in
 * `routes/agents/tests.js` runs through `requireEditableAgent` and gives 403
 * `agent_not_editable`. That is a deliberate, narrow choice (a test question is building
 * material), and the card may therefore not draw it as a fault. It arrives as
 * `readRefusal` and gets the refusal banner, without a Retry button. The card thereby
 * promises nothing that the server does not give.
 */

/** De statuskleur en het glyph van één resultaat. Vier statussen, vier vormen. */
const STATUS_LOOK = Object.freeze<Record<string, { Icon: LucideIcon; color: string }>>({
    pass: { Icon: CheckCircle2, color: 'var(--success, #16a34a)' },
    fail: { Icon: XCircle, color: 'var(--error, #dc2626)' },
    blocked: { Icon: Ban, color: 'var(--text-tertiary)' },
    error: { Icon: CircleHelp, color: 'var(--warning)' },
});

function StatusDot({ status }: StatusDotProps) {
    const look = STATUS_LOOK[status] || STATUS_LOOK.error;
    const Icon = look.Icon;
    return <Icon size={14} aria-hidden="true" style={{ color: look.color, flexShrink: 0 }} />;
}

/**
 * The sentence for one problem.
 *
 * Purely based on `kind` from `problemFor`, so the closed values of the server
 * (`decidedBy`) and the FACTS (a forbidden word that is literally present, a tool that was
 * never called) each get their own translatable rule. The English sentence that the server
 * stored is not shown: it is not translated and says the same thing.
 */
function problemSentence(t: TranslateFn, problem: { status: string; kind: string; names: string[]; reason: string } | null) {
    if (!problem) return '';
    const names = (problem.names || []).join(', ');
    switch (problem.kind) {
        case 'forbidden':
            return t('agent_studio.test.fail_forbidden', 'Said something this test forbids: {names}', { names });
        case 'tools_missing':
            return t('agent_studio.test.fail_tools_missing', 'Did not use: {names}', { names });
        case 'withheld':
            return names
                ? t('agent_studio.test.blocked_withheld', 'A test run never uses {names}, so this could not be checked.', { names })
                : t('agent_studio.test.blocked_plain', 'This expectation cannot be checked in a test run.');
        case 'ungraded':
            return t('agent_studio.test.errored', 'There was no answer to grade, so this says nothing about the agent.');
        case 'decided:must_mention':
            return t('agent_studio.test.fail_must_mention', 'Did not get across everything this test asks for.');
        case 'decided:must_not_mention':
            return t('agent_studio.test.fail_must_not_mention', 'Said something this test forbids.');
        case 'decided:tools':
            return t('agent_studio.test.fail_tools', 'Did not use the tools this test expects.');
        case 'decided:rules':
            return t('agent_studio.test.fail_rules', 'Did not follow the rules this test expects.');
        case 'decided:notes':
            return t('agent_studio.test.fail_notes', 'Did not meet the extra note on this test.');
        default:
            return t('agent_studio.test.fail_overall', 'Not a usable answer to the question.');
    }
}

/** De zin bij een weigering. Elke soort zegt óók dat er niets getest is. */
function refusalSentence(t: TranslateFn, refusal: Refusal) {
    switch (refusal.kind) {
        case REFUSAL.NO_GRADER:
            return t('agent_studio.test.refused_no_grader', 'No AI model is set up to grade these answers, so nothing was tested.');
        case REFUSAL.NO_SUGGESTER:
            return t('agent_studio.test.refused_no_suggester', 'No AI model is set up to write this suggestion.');
        case REFUSAL.MODEL_UNREADABLE:
            return t('agent_studio.test.refused_model_unreadable', 'Could not look up which model does this, so nothing ran.');
        case REFUSAL.SUGGESTION_UNREADABLE:
            return t('agent_studio.test.refused_suggestion', 'Could not write a suggestion for this answer.');
        case REFUSAL.LIMIT:
            return t('agent_studio.test.refused_limit', 'Your plan has no room for a test run right now, so nothing was tested.');
        case REFUSAL.CHECK_FAILED:
            return t('agent_studio.test.refused_check', 'Could not check your workspace or your plan, so nothing ran.');
        case REFUSAL.NOTHING_TO_RUN:
            return t('agent_studio.test.refused_empty', 'There is nothing to run yet — write a question first.');
        case REFUSAL.NOT_EDITABLE:
            // What is true: this agent keeps tests, and you may not see them.
            // The old sentence ("You can look at these tests, but not run them")
            // promised precisely the read that the server refuses.
            return t('agent_studio.test.refused_not_editable', 'You need edit access to this agent to see and run its tests.');
        case REFUSAL.TOO_MANY:
            return t('agent_studio.test.refused_too_many', 'This agent already holds as many tests as it can.');
        case REFUSAL.NOT_SAVED:
            return t('agent_studio.test.refused_not_saved', 'The tests ran, but the result could not be saved — so this score is not kept.');
        case REFUSAL.RUN_STOPPED:
            // "Nothing was tested" would be false here: the results that already came in
            // are shown beneath it on the screen.
            return t('agent_studio.test.refused_run_stopped', 'The run stopped part-way. What you see below is what had already been tested.');
        default:
            // Unknown narrows: we do not know HOW FAR it got, so we also do not claim that
            // nothing was tested.
            return t('agent_studio.test.refused_unknown', 'Could not finish the test run.');
    }
}

function RefusalNotice({ t, refusal, onRetry }: RefusalNoticeProps) {
    return (
        <div
            role="status"
            data-testid="agent-tests-refusal"
            data-kind={refusal.kind}
            className="flex items-start gap-2 px-4 py-3 text-[12px] [background:color-mix(in_srgb,var(--warning)_8%,transparent)]"
        >
            <AlertTriangle size={14} aria-hidden="true" style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
            <span className="flex-1 text-[var(--text-secondary)]">{refusalSentence(t, refusal)}</span>
            {refusal.retryable && onRetry && (
                <button
                    type="button"
                    data-testid="agent-tests-refusal-retry"
                    onClick={onRetry}
                    className="px-2 py-0.5 rounded-md border border-[var(--border-default)] hover:bg-[var(--bg-secondary)] transition flex-shrink-0"
                >
                    {t('agent_studio.retry', 'Retry')}
                </button>
            )}
        </div>
    );
}

function ScoreLine({ t, summary, questionCount, progress }: ScoreLineProps) {
    // A running run has no result. What is there is progress, and it must read that way too:
    // not as an interim tally that claims "3 passed".
    if (progress && progress.status === PROGRESS.RUNNING) {
        return (
            <div data-testid="agent-tests-score" data-state="running" className="text-[15px] font-semibold text-[var(--text-primary)]">
                {progress.total === null
                    ? t('agent_studio.test.running', 'Running…')
                    : t('agent_studio.test.running_n', 'Running… {done} of {total}', { done: progress.done, total: progress.total })}
            </div>
        );
    }
    if (progress && progress.status === PROGRESS.UNFINISHED) {
        return (
            <div data-testid="agent-tests-score" data-state="unfinished" className="text-[13px] text-[var(--text-secondary)]">
                {t('agent_studio.test.run_unfinished', 'That run did not finish, so it is not a result.')}
            </div>
        );
    }
    const justRan = justRanScore(progress);
    if (justRan) {
        return (
            <div data-testid="agent-tests-score" data-state="result" data-kept={justRan.kept ? 'yes' : 'no'}
                className="text-[15px] font-semibold text-[var(--text-primary)]">
                {t('agent_studio.test.score', '{passed} of {total} passed',
                    { passed: justRan.passed, total: justRan.total })}
            </div>
        );
    }
    switch (summary.state) {
        case RUN_STATE.RESULT:
            return (
                <div data-testid="agent-tests-score" data-state="result" className="text-[15px] font-semibold text-[var(--text-primary)]">
                    {t('agent_studio.test.score', '{passed} of {total} passed', { passed: summary.passed, total: summary.total })}
                </div>
            );
        case RUN_STATE.UNKNOWN:
            return (
                <div data-testid="agent-tests-score" data-state="unknown" className="text-[13px] text-[var(--warning)]">
                    {t('agent_studio.test.last_run_unknown', 'Could not read the last run, so nothing is claimed here.')}
                </div>
            );
        case RUN_STATE.UNFINISHED:
            return (
                <div data-testid="agent-tests-score" data-state="unfinished" className="text-[13px] text-[var(--warning)]">
                    {t('agent_studio.test.stored_unfinished', 'The last run did not finish, so there is no score for it.')}
                </div>
            );
        default:
            return (
                <div data-testid="agent-tests-score" data-state="never" className="text-[15px] font-semibold text-[var(--text-primary)]">
                    {questionCount === 0
                        ? t('agent_studio.test.no_questions', 'No questions yet')
                        : t('agent_studio.test.never_run', 'Not run yet')}
                </div>
            );
    }
}

function AboutLine({ t, summary, justRan = null }: AboutLineProps) {
    if (justRan && !justRan.kept) return null;
    if (summary.state !== RUN_STATE.RESULT) return null;
    const parts = [];
    if (summary.source === 'published' && summary.version) {
        parts.push(t('agent_studio.test.about_version', 'about v{version}', { version: summary.version }));
        if (summary.unpublishedChanges !== null && summary.unpublishedChanges > 0) {
            parts.push(nOf(t, 'agent_studio.test.about_ahead', summary.unpublishedChanges,
                '{count} unpublished change since', '{count} unpublished changes since'));
        }
    } else if (summary.source === 'live') {
        parts.push(t('agent_studio.test.about_draft', 'about your draft'));
    }
    if (summary.coverage && summary.coverage.of !== null && summary.coverage.ran !== summary.coverage.of) {
        // Two sentences, because there are two different facts: how many questions stand NOW
        // (the normal case), and how many stood THEN, when the run ran (if the current list
        // could not be read).
        parts.push(summary.coverage.when === 'then'
            ? nOf(t, 'agent_studio.test.covers_then', summary.coverage.of,
                'covers {ran} of the {count} question this agent had then',
                'covers {ran} of the {count} questions this agent had then',
                { ran: summary.coverage.ran })
            : nOf(t, 'agent_studio.test.covers', summary.coverage.of,
                'covers {ran} of the {count} question you have now',
                'covers {ran} of the {count} questions you have now',
                { ran: summary.coverage.ran }));
    }
    const stale = summary.stale.changed
        ? t('agent_studio.test.stale_changed', 'A question changed after this run, so the score is about the older wording.')
        : summary.stale.added
            ? t('agent_studio.test.stale_added', 'A question was added after this run.')
            : summary.stale.removed
                ? t('agent_studio.test.stale_removed', 'This run covered a question that no longer exists.')
                : null;
    if (parts.length === 0 && !stale) return null;
    return (
        <div data-testid="agent-tests-about" className="text-[12px] text-[var(--text-tertiary)]">
            {parts.join(' · ')}
            {stale && <span className="block text-[var(--warning)]">{stale}</span>}
        </div>
    );
}

function FailLine({ t, items }: FailLineProps) {
    const first = firstProblem(items);
    if (!first) return null;
    return (
        <div data-testid="agent-tests-fail-line" data-status={first.item.status} className="flex items-start gap-2 text-[12px]">
            <span className="mt-0.5"><StatusDot status={first.item.status} /></span>
            <span className="min-w-0 flex-1 text-[var(--text-secondary)]">
                <span className="text-[var(--text-primary)]">{first.item.name || t('agent_studio.test.unnamed', 'Untitled question')}</span>
                {' — '}
                {problemSentence(t, first.problem)}
                {first.moreCount > 0 && (
                    <span className="block text-[var(--text-tertiary)]" data-testid="agent-tests-more-problems">
                        {nOf(t, 'agent_studio.test.more_problems', first.moreCount,
                            '{count} more question is not green.', '{count} more questions are not green.')}
                    </span>
                )}
            </span>
        </div>
    );
}

/**
 * Did a MODEL write part of this expectation?
 *
 * `writtenBy` comes from the storage (agent_tests.written_by) and is null for every test
 * that someone typed himself. Without this marker, an expectation written by a model was
 * no longer distinguishable after saving from a typed one, while every run result that
 * follows from it relies on it.
 */
function aiWrote(test: AgentTest) {
    const by = test && test.writtenBy;
    if (!by || typeof by !== 'object') return false;
    return Object.values(by).some(v => v === 'ai');
}

function TestRow({ t, test, item }: TestRowProps) {
    const problem = item ? problemFor(item) : null;
    return (
        <div data-testid="agent-tests-question-row" data-status={item ? item.status : 'none'} className="flex items-start gap-3 px-4 py-2.5">
            <span className="mt-0.5">{item ? <StatusDot status={item.status} /> : <FlaskConical size={14} aria-hidden="true" className="text-[var(--text-tertiary)]" />}</span>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[13px] text-[var(--text-primary)] truncate">{test.name || test.question}</span>
                    {aiWrote(test) && (
                        <span
                            data-testid="agent-tests-question-ai"
                            className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-md border border-[var(--border-default)] text-[var(--text-tertiary)]"
                            title={t('agent_studio.test.written_by_ai_hint', 'An AI proposed part of what this test expects. A person saved it.')}
                        >
                            {t('agent_studio.test.written_by_ai', 'AI wrote this')}
                        </span>
                    )}
                </div>
                <div className="text-[12px] text-[var(--text-tertiary)]">
                    {item
                        ? (problem ? problemSentence(t, problem) : t('agent_studio.test.row_pass', 'Met the expectations in the last run.'))
                        : t('agent_studio.test.row_not_in_run', 'Not part of the last run.')}
                </div>
            </div>
        </div>
    );
}

/**
 * One line of run history. A row without a result shows none.
 *
 * And it does NOT say "The last run …": that sentence belongs to the heading. In the
 * history it stood under every unfinished row, also under the fifth from the top. A row in
 * a list speaks for itself.
 */
function RunRow({ t, rel, row }: { t: TranslateFn; rel: ((dateLike: RelativeTimeInput) => string) | null; row: TestRun }) {
    const summary = summariseRun({ lastRun: row });
    return (
        <div data-testid="agent-tests-run-row" data-state={summary.state} className="flex items-center gap-3 px-4 py-2 text-[12px]">
            <span className="text-[var(--text-tertiary)] flex-shrink-0">{rel ? rel(row.ranAt) : row.ranAt}</span>
            <span className="flex-1 text-[var(--text-secondary)]">
                {summary.state === RUN_STATE.RESULT
                    ? t('agent_studio.test.score', '{passed} of {total} passed', { passed: summary.passed, total: summary.total })
                    : t('agent_studio.test.run_row_unfinished', 'This run did not finish, so there is no score for it.')}
            </span>
            {summary.version ? (
                <span className="text-[var(--text-tertiary)] flex-shrink-0">
                    {t('agent_studio.test.version_short', 'v{version}', { version: summary.version })}
                </span>
            ) : null}
        </div>
    );
}

export default function TestSetCard({
    t, ro = false, rel = null,
    tests = [], testsState = READ.OK, onRetryTests = null, readRefusal = null,
    lastRun = null, lastRunUnknown = false,
    runs = [], runsState = READ.OK, runsUnknown = false, runsKeep = 0, onOpenDetail = null,
    progress = null,
    refusal = null, onRetryRun = null,
    onRun = null, running = false,
    onAddFromChat = null, canAddFromChat = false,
}: TestSetCardProps) {
    const [open, setOpen] = useState(false);
    const summary = summariseRun({ lastRun, lastRunUnknown, tests });
    // The run that just finished, or null as long as there is none. See ScoreLine: that one
    // wins over the stored run, because the rest of the card is also about it.
    const justRan = justRanScore(progress);
    // What is shown in the list is the LAST completed result, or the run that just finished.
    // A running run fills the list while it runs, but does not yet yield a tally. See ScoreLine.
    const liveItems = progress && progress.items && progress.items.length > 0 ? progress.items : null;
    const items = liveItems || (summary.state === RUN_STATE.RESULT ? summary.items : []);
    const showFailLine = liveItems || summary.state === RUN_STATE.RESULT;

    const toggle = () => {
        setOpen((v) => {
            if (!v) onOpenDetail?.();
            return !v;
        });
    };

    return (
        <section
            data-testid="agent-tests-card"
            className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card,#fff)] overflow-hidden mb-6"
        >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-default)]">
                <span className="flex-shrink-0 text-[var(--text-secondary)]" aria-hidden="true"><FlaskConical size={16} /></span>
                <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-semibold text-[var(--text-primary)] truncate">
                        {t('agent_studio.test.card_title', 'Test set')}
                    </span>
                    <span className="block text-[12px] text-[var(--text-tertiary)] truncate">
                        {t('agent_studio.test.card_sub', 'Questions this agent should keep answering well')}
                    </span>
                </span>
                {!ro && onRun && (
                    <button
                        type="button"
                        data-testid="agent-tests-run"
                        onClick={onRun}
                        disabled={running || tests.length === 0}
                        className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 transition flex-shrink-0"
                    >
                        <Play size={14} aria-hidden="true" />
                        {running ? t('agent_studio.test.running', 'Running…') : t('agent_studio.test.run', 'Run')}
                    </button>
                )}
            </div>

            {/* If the SERVER refused the read, that is not a fault and Retry does not help. Every
                route here asks for edit rights, so whoever may only view this agent gets 403.
                That sentence belongs in the refusal banner, not in the yellow "could not load". */}
            {readRefusal
                ? <RefusalNotice t={t} refusal={readRefusal} onRetry={readRefusal.retryable ? onRetryTests : null} />
                : testsState === READ.ERROR && (
                    <UnreadableNotice
                        testId="agent-tests-unreadable"
                        message={t('agent_studio.test.tests_unreadable', 'Could not load the questions, so what is claimed here may be incomplete.')}
                        retryLabel={t('agent_studio.retry', 'Retry')}
                        onRetry={onRetryTests}
                    />
                )}

            {refusal && <RefusalNotice t={t} refusal={refusal} onRetry={refusal.retryable ? onRetryRun : null} />}

            <div className="px-4 py-3 flex flex-col gap-1.5">
                <ScoreLine t={t} summary={summary} questionCount={tests.length} progress={progress} />
                {summary.state !== RUN_STATE.RESULT && tests.length > 0 && (
                    <div className="text-[12px] text-[var(--text-tertiary)]" data-testid="agent-tests-question-count">
                        {nOf(t, 'agent_studio.test.n_questions', tests.length, '{count} question', '{count} questions')}
                    </div>
                )}
                <AboutLine t={t} summary={summary} justRan={justRan} />
                {/* A result that is not stored anywhere says so itself. Otherwise there is a score
                    without any hint that it will be gone tomorrow, and with a "Test as" simulation
                    there is not even a refusal that explains it. */}
                {justRan && !justRan.kept && (
                    <div className="text-[12px] text-[var(--warning)]" data-testid="agent-tests-not-kept">
                        {justRan.notStored === 'test_as'
                            ? t('agent_studio.test.not_kept_test_as', 'This was a simulation for one group, so the score is not kept.')
                            : t('agent_studio.test.not_kept', 'This score is not kept.')}
                    </div>
                )}
                {showFailLine && <FailLine t={t} items={items} />}
            </div>

            <div className="flex items-center gap-2 px-4 pb-3">
                <button
                    type="button"
                    data-testid="agent-tests-view"
                    aria-expanded={open}
                    onClick={toggle}
                    className="flex items-center gap-1 h-8 px-2.5 rounded-lg text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition"
                >
                    {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                    {t('agent_studio.test.view', 'View')}
                </button>
                {/* Only if there IS a turn to record. Without a conversation this button would open an
                    empty form asking for a question you had just asked. */}
                {!ro && onAddFromChat && canAddFromChat && (
                    <button
                        type="button"
                        data-testid="agent-tests-add-from-chat"
                        onClick={onAddFromChat}
                        className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[13px] font-medium border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition"
                    >
                        <Plus size={14} aria-hidden="true" />
                        {t('agent_studio.test.add_from_chat', 'This conversation as a test')}
                    </button>
                )}
                {!ro && onAddFromChat && !canAddFromChat && (
                    <span data-testid="agent-tests-add-hint" className="text-[12px] text-[var(--text-tertiary)]">
                        {t('agent_studio.test.add_from_chat_hint', 'Ask this agent something first, then turn that answer into a test.')}
                    </span>
                )}
            </div>

            {open && (
                <div data-testid="agent-tests-detail" className="border-t border-[var(--border-default)]">
                    <div className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">
                        {t('agent_studio.test.questions_heading', 'Questions')}
                    </div>
                    <div className="divide-y divide-[var(--border-default)]">
                        {tests.length === 0 && (
                            <EmptyRow
                                testId="agent-tests-empty"
                                message={t('agent_studio.test.empty', 'No questions yet — turn an answer you liked into the first one.')}
                            />
                        )}
                        {tests.map((test) => (
                            <TestRow
                                key={test.id}
                                t={t}
                                test={test}
                                item={items.find(i => i && i.testId === test.id) || null}
                            />
                        ))}
                    </div>

                    <div className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">
                        {t('agent_studio.test.history_heading', 'Earlier runs')}
                    </div>
                    {runsUnknown || runsState === READ.ERROR ? (
                        <UnreadableNotice
                            testId="agent-tests-runs-unreadable"
                            message={t('agent_studio.test.runs_unreadable', 'Could not read the earlier runs, so this is not the whole history.')}
                            retryLabel={t('agent_studio.retry', 'Retry')}
                            onRetry={onOpenDetail}
                        />
                    ) : runsState === READ.LOADING ? (
                        <EmptyRow testId="agent-tests-runs-loading" message={t('agent_studio.test.runs_loading', 'Loading…')} />
                    ) : runs.length === 0 ? (
                        <EmptyRow
                            testId="agent-tests-runs-empty"
                            message={t('agent_studio.test.runs_empty', 'This set has never been run.')}
                        />
                    ) : (
                        <div className="divide-y divide-[var(--border-default)] pb-2">
                            {runs.map((row) => <RunRow key={row.id} t={t} rel={rel} row={row} />)}
                            {runsKeep > 0 && runs.length >= runsKeep && (
                                <div data-testid="agent-tests-runs-pruned" className="px-4 py-2 text-[11px] text-[var(--text-tertiary)]">
                                    {nOf(t, 'agent_studio.test.runs_kept', runsKeep,
                                        'Only the last {count} run is kept.', 'Only the last {count} runs are kept.')}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}
