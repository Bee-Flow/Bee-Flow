import { AlertTriangle, Ban, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, FlaskConical, Play, Plus, XCircle } from 'lucide-react';
import React, { useState } from 'react';
import {
    PROGRESS, REFUSAL, RUN_STATE,
    firstProblem, justRanScore, problemFor, summariseRun,
} from './testSetFacts';
import { nOf } from '../../../admin/Studio/KnowledgeStudio/plural';
import { EmptyRow, UnreadableNotice } from '../canUse/CanUseCard';
import { READ } from '../canUse/canUseFacts';

/**
 * De testset-kaart van de Test-tab (Agents-artboard 1c, A4 deel D).
 *
 * Vier dingen, en drie ervan zijn er om te voorkomen dat de kaart iets beweert
 * wat ze niet weet:
 *
 *   DE TELLING   "11 / 12 goed" is een uitslag van één RUN. Nooit gedraaid is
 *                geen "0 / 12" (er is niets gevraagd), een lezing die mislukte
 *                is dat ook niet, en een run die halverwege omviel is geen
 *                uitslag. `testSetFacts.summariseRun` beslist welke van de
 *                vier het is; deze kaart schrijft er alleen de zin bij.
 *   DE FAALREGEL het ene niet-groene resultaat, met WAAROM. `fail`, `blocked`
 *                en `error` zijn drie verschillende dingen en krijgen drie
 *                verschillende zinnen: alleen de eerste zegt iets over de
 *                agent.
 *   BEKIJK       de vragen met hun laatste oordeel, plus de run-historie —
 *                want één getal zonder geschiedenis maakt van een toevallige
 *                groene run een feit.
 *   + DIT GESPREK ALS TEST
 *                de knop die van de laatste beurt een test maakt. Hij staat er
 *                alleen als er een beurt IS; een knop die nergens heen kan is
 *                erger dan geen knop.
 *
 * ── EEN WEIGERING IS GEEN MISLUKTE TEST ─────────────────────────────
 * "Er is geen model ingericht om deze antwoorden te beoordelen" komt terug
 * vóór er één beurt gedraaid heeft (`POST /:id/tests/run` weigert met 503).
 * Die weigering wordt hier als weigering getekend en laat de telling met rust.
 * Als hij als rode tests zou landen, gaat iemand zijn agent repareren terwijl
 * er niets mis is met zijn agent — en dat is precies het soort vals-rood dat
 * mensen leert de testset te negeren.
 *
 * ── ALLEEN-LEZEN HAALT DE ACTIES WEG, EN DE SERVER DE FEITEN ────────
 * `ro` verbergt Run en "+ Dit gesprek als test" (BFSF-271: alleen-lezen haalt
 * de BEWERKENDE affordances weg). De telling, de faalregel en Bekijk blijven —
 * ZOLANG de lezing lukt.
 *
 * En die lukt vandaag niet voor iemand die alleen mag bekijken: elke route in
 * `routes/agents/tests.js` loopt door `requireEditableAgent` en geeft 403
 * `agent_not_editable`. Dat is een bewuste, smalle keuze (een testvraag is
 * bouwmateriaal), en de kaart mag hem dus niet als storing tekenen. Hij komt
 * binnen als `readRefusal` en krijgt de weigeringsbanner, zonder Opnieuw-knop.
 * De kaart belooft daarmee niets wat de server niet geeft.
 */

/** De statuskleur en het glyph van één resultaat. Vier statussen, vier vormen. */
const STATUS_LOOK = Object.freeze({
    pass: { Icon: CheckCircle2, color: 'var(--success, #16a34a)' },
    fail: { Icon: XCircle, color: 'var(--error, #dc2626)' },
    blocked: { Icon: Ban, color: 'var(--text-tertiary)' },
    error: { Icon: CircleHelp, color: 'var(--warning)' },
});

function StatusDot({ status }) {
    const look = STATUS_LOOK[status] || STATUS_LOOK.error;
    const Icon = look.Icon;
    return <Icon size={14} aria-hidden="true" style={{ color: look.color, flexShrink: 0 }} />;
}

/**
 * De zin bij één probleem.
 *
 * Puur op `kind` uit `problemFor`, dus de gesloten waarden van de server
 * (`decidedBy`) en de FEITEN (een verboden woord dat er letterlijk staat, een
 * tool die nooit is aangeroepen) krijgen elk hun eigen vertaalbare regel. De
 * Engelse zin die de server opsloeg wordt niet getoond: die is niet vertaald
 * en zegt hetzelfde.
 */
function problemSentence(t, problem) {
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
function refusalSentence(t, refusal) {
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
            // Wat waar is: deze agent bewaart tests, en jij mag ze niet zien.
            // De oude zin ("You can look at these tests, but not run them")
            // beloofde precies de lezing die de server juist weigert.
            return t('agent_studio.test.refused_not_editable', 'You need edit access to this agent to see and run its tests.');
        case REFUSAL.TOO_MANY:
            return t('agent_studio.test.refused_too_many', 'This agent already holds as many tests as it can.');
        case REFUSAL.NOT_SAVED:
            return t('agent_studio.test.refused_not_saved', 'The tests ran, but the result could not be saved — so this score is not kept.');
        case REFUSAL.RUN_STOPPED:
            // "Nothing was tested" zou hier onwaar zijn: de resultaten die al
            // binnenkwamen staan eronder op het scherm.
            return t('agent_studio.test.refused_run_stopped', 'The run stopped part-way. What you see below is what had already been tested.');
        default:
            // Onbekend versmalt: we weten niet HOEVER hij gekomen is, dus we
            // beweren ook niet dat er niets getest is.
            return t('agent_studio.test.refused_unknown', 'Could not finish the test run.');
    }
}

/** De weigering, met de knop erbij als opnieuw proberen zin heeft. */
function RefusalNotice({ t, refusal, onRetry }) {
    return (
        <div
            role="status"
            data-testid="agent-tests-refusal"
            data-kind={refusal.kind}
            className="flex items-start gap-2 px-4 py-3 text-[12px]"
            style={{ background: 'color-mix(in srgb, var(--warning) 8%, transparent)' }}
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

/**
 * "11 / 12 goed", of de reden dat er geen getal staat.
 *
 * VOLGORDE: een run die je zojuist zag lopen gaat vóór de opgeslagen run.
 * Anders toont de kopregel na een niet-bewaarde run (een "Test als"-simulatie,
 * of een run waarvan het opslaan mislukte) de telling van de VORIGE run,
 * terwijl de faalregel en de vraagregels eronder over de zojuist gedraaide
 * run gaan — en de weigering "…so this score is not kept" leest dan als een
 * uitspraak over precies het getal dat juist wél bewaard is.
 */
function ScoreLine({ t, summary, questionCount, progress }) {
    // Een lopende run heeft geen uitslag. Wat er staat is voortgang, en dat
    // moet ook zo lezen — niet als een tussenstand die "3 goed" beweert.
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
                <div data-testid="agent-tests-score" data-state="unknown" className="text-[13px]" style={{ color: 'var(--warning)' }}>
                    {t('agent_studio.test.last_run_unknown', 'Could not read the last run, so nothing is claimed here.')}
                </div>
            );
        case RUN_STATE.UNFINISHED:
            return (
                <div data-testid="agent-tests-score" data-state="unfinished" className="text-[13px]" style={{ color: 'var(--warning)' }}>
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

/**
 * Waar de uitslag over ging: welke versie, hoeveel vragen, en hoe oud.
 *
 * `justRan` is de run die zojuist afliep. Was die NIET bewaard, dan gaat de
 * kopregel over die run en zou deze regel over een oudere gaan — "about v3"
 * boven een score die niets met v3 te maken heeft. Dan liever niets: van deze
 * run weten we de versie pas als hij opgeslagen is.
 */
function AboutLine({ t, summary, justRan = null }) {
    if (justRan && !justRan.kept) return null;
    if (summary.state !== RUN_STATE.RESULT) return null;
    const parts = [];
    if (summary.source === 'published' && summary.version) {
        parts.push(t('agent_studio.test.about_version', 'about v{version}', { version: summary.version }));
        if (summary.unpublishedChanges > 0) {
            parts.push(nOf(t, 'agent_studio.test.about_ahead', summary.unpublishedChanges,
                '{count} unpublished change since', '{count} unpublished changes since'));
        }
    } else if (summary.source === 'live') {
        parts.push(t('agent_studio.test.about_draft', 'about your draft'));
    }
    if (summary.coverage && summary.coverage.of !== null && summary.coverage.ran !== summary.coverage.of) {
        // Twee zinnen, want twee verschillende feiten: hoeveel vragen er NU
        // staan (het normale geval) en hoeveel er stonden TOEN de run liep (als
        // de huidige lijst niet gelezen kon worden).
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
            {stale && <span className="block" style={{ color: 'var(--warning)' }}>{stale}</span>}
        </div>
    );
}

/** De faalregel: het dringendste niet-groene resultaat, met waarom. */
function FailLine({ t, items }) {
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
 * Schreef een MODEL een deel van deze verwachting?
 *
 * `writtenBy` komt uit de opslag (agent_tests.written_by) en is null voor elke
 * test die iemand zelf tikte. Zonder dit merkje was een door een model
 * opgestelde verwachting na het opslaan niet meer te onderscheiden van een
 * getikte — terwijl elke run-uitslag die eruit volgt erop leunt.
 */
function aiWrote(test) {
    const by = test && test.writtenBy;
    if (!by || typeof by !== 'object') return false;
    return Object.values(by).some(v => v === 'ai');
}

/** Eén vraag met het oordeel dat de laatste run erover gaf — of geen oordeel. */
function TestRow({ t, test, item }) {
    const problem = item ? problemFor(item) : null;
    return (
        <div data-testid="agent-tests-question-row" data-status={item ? item.status : 'none'} className="flex items-start gap-3 px-4 py-2.5">
            <span className="mt-0.5">{item ? <StatusDot status={item.status} /> : <FlaskConical size={14} aria-hidden="true" style={{ color: 'var(--text-tertiary)' }} />}</span>
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
 * Eén regel run-historie. Een rij zonder uitslag toont er geen.
 *
 * En zegt daarbij NIET "The last run …": die zin hoort bij de kopregel, en in
 * de historie stond hij onder elke onafgeronde rij — ook onder de vijfde van
 * boven. Een rij in een lijst spreekt over zichzelf.
 */
function RunRow({ t, rel, row }) {
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
}) {
    const [open, setOpen] = useState(false);
    const summary = summariseRun({ lastRun, lastRunUnknown, tests });
    // De run die zojuist afliep — of null zolang er geen is. Zie ScoreLine:
    // die wint van de opgeslagen run, want de rest van de kaart gaat er ook
    // over.
    const justRan = justRanScore(progress);
    // Wat er in de lijst getoond wordt is de LAATSTE afgeronde uitslag, of de
    // run die zojuist afliep. Een lopende run vult de lijst terwijl hij loopt,
    // maar levert nog geen telling — zie ScoreLine.
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

            {/* Weigerde de SERVER de lezing, dan is dat geen storing en helpt
                Opnieuw niet — elke route hier vraagt bewerkrecht, dus wie deze
                agent alleen mag bekijken krijgt 403. Die zin hoort in de
                weigeringsbanner te staan, niet in de gele "kon niet laden". */}
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
                {/* Een uitslag die nergens bewaard is, zegt dat zelf. Anders
                    staat er een score zonder enige aanwijzing dat hij morgen
                    weg is — en bij een "Test als"-simulatie is er niet eens
                    een weigering die het uitlegt. */}
                {justRan && !justRan.kept && (
                    <div className="text-[12px]" style={{ color: 'var(--warning)' }} data-testid="agent-tests-not-kept">
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
                {/* Alleen als er een beurt IS om vast te leggen. Zonder gesprek
                    zou deze knop een leeg formulier openen dat om een vraag
                    vraagt die je net had. */}
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
