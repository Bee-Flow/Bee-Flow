import type { OrbStep } from '@/api/coworkPlan.types';
/**
 * The home composer starts a fixed task's held test directly when the brief provides everything it needs.
 * Advanced, a requested delivery, or a question opens the editable preview first. Workspaces without fixed
 * steps always confirm before creating the task. Setup progress ends with the result ready for review.
 *
 * Editing the sentence while the card is open does not throw the card away: a moment after the last keystroke the
 * sentence is read again and the card's rows follow it, except the ones the owner already changed by hand
 * (`choices`, kept here so they outlive the draft). An emptied box closes the card.
 *
 * A sentence handed over by "Make it a task" in the chat (./coworkHandedBrief.ts) fills the box once, set to run every
 * week on the day it was asked; a template's sentence (`seed`) fills it too.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import CoworkStepPicker from './CoworkStepPicker';
import CoworkExamples from './CoworkExamples';
import CoworkConfirmCard, { useMayHaveSteps } from './CoworkConfirmCard';
import CoworkSurface from './CoworkSurface';
import CoworkActivity, { setupActivity } from './CoworkActivity';
import { confirmView, isClockPayload, needsDay, startPayload, type ConfirmChoices } from './coworkConfirmModel';
import { takeHandedBrief } from './coworkHandedBrief';
import { ALERT, BUTTON_PRIMARY, CARD, LINK_BUTTON, META } from './coworkUi';
import useCoworkComposer, { type CoworkDraft, type UseCoworkComposerReturn } from './useCoworkComposer';
import useCoworkApps from './useCoworkApps';
import type { TaskSetup } from './useTaskSetup';
import CoworkModelPicker from './CoworkModelPicker';
import useModelTierSelection from '@/hooks/useModelTierSelection';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import type { CoworkItem, CoworkPayload, CoworkTriggerPayload } from '@/api/cowork.types';

export interface CoworkHomeComposerProps {
    /** No room for another task: the box says so instead of offering to read the sentence. */
    atLimit: boolean;
    maxItems: number;
    stepTypes?: string[];
    /** A sentence to put in the box (a template's), with a counter so the same one can be put twice. */
    seed?: { text: string; n: number } | null;
    onTemplates: () => void;
    /** A task was created: set up and test its steps. */
    onCreated: (item: CoworkItem) => void;
    /** The task whose steps are being set up now, if any. */
    setup: TaskSetup | null;
    finished?: { flow?: OrbStep[]; apps?: string[] | null; title: string; message: string; onOpen: () => void; onReset: () => void };

}

/** How long after the last keystroke an edited sentence is read again. */
const REREAD_MS = 700;
const RETRY_MS = 200;

/**
 * Reading an edited sentence again, a moment after the last keystroke. `edit` is called with every change while the
 * card is open; `waiting` says a read is due or on the go. A read that is still running is waited for, so the last
 * text is always the one that is read.
 */
function useReread(cowork: UseCoworkComposerReturn, modelTier: string | undefined) {
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const now = useRef({ submitting: cowork.submitting, submit: cowork.submit, modelTier });
    useEffect(() => { now.current = { submitting: cowork.submitting, submit: cowork.submit, modelTier }; });
    const [waiting, setWaiting] = useState(false);
    const stop = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        setWaiting(false);
    }, []);
    useEffect(() => stop, [stop]);
    const edit = useCallback((text: string) => {
        if (timer.current) clearTimeout(timer.current);
        setWaiting(true);
        const read = () => {
            if (now.current.submitting) { timer.current = setTimeout(read, RETRY_MS); return; }
            timer.current = null;
            setWaiting(false);
            void now.current.submit(text, { modelTier: now.current.modelTier });
        };
        timer.current = setTimeout(read, REREAD_MS);
    }, []);
    return { edit, stop, waiting };
}

function canRead(text: string, atLimit: boolean, cowork: UseCoworkComposerReturn) {
    return !!text.trim() && !atLimit && !cowork.draft && !cowork.submitting;
}

function showExamples(atLimit: boolean, text: string, cowork: UseCoworkComposerReturn) {
    return !atLimit && !text && !cowork.draft;
}

/** Direct setup is only for fixed tasks held for a test. A destination, schedule question or agent needs review. */
function useQuickTest(advanced: boolean, text: string, setStarting: (value: boolean) => void) {
    const mayTest = useMayHaveSteps();
    const quick = mayTest && !advanced;
    const { availableApps } = useCoworkApps();
    const prepareTest = (draft: CoworkDraft): CoworkPayload | null => {
        if (!draft.spec || draft.spec.missingTarget || needsDay(draft) || draft.payload.agentId || !isClockPayload(draft.payload)) return null;
        const view = confirmView(draft, {}, text, availableApps.filter(app => !app.isStep));
        if (view.deliveryRequested) return null;
        const payload = startPayload(view, true);
        if (!isClockPayload(payload)) return null;
        setStarting(true);
        return payload;
    };
    return { quick, prepareTest };
}

function useTaskBrief({ atLimit, seed = null, onCreated }: CoworkHomeComposerProps) {
    const [handed] = useState(takeHandedBrief);
    const [text, setText] = useState(handed.brief);
    const [choices, setChoices] = useState<ConfirmChoices>({});
    const [advanced, setAdvanced] = useState(false);
    const [starting, setStarting] = useState(false);
    const box = useRef<HTMLTextAreaElement>(null);
    const { selectedTier, setSelectedTier, modelTiers } = useModelTierSelection({ storageKey: 'coworkTier', taskType: 'automation' });
    const cowork = useCoworkComposer({ confirm: true, weeklyOn: handed.weekday });
    const { stop, ...reread } = useReread(cowork, selectedTier);
    const { reset } = cowork;
    const close = useCallback(() => { stop(); setChoices({}); setAdvanced(false); reset(); }, [stop, reset]);

    // A new seed fills the box (state from a newer input, set while rendering); the focus follows it after.
    const [seeded, setSeeded] = useState(seed);
    if (seed !== seeded) {
        setSeeded(seed);
        if (seed) { setText(seed.text); close(); }
    }
    useEffect(() => { if (seeded) box.current?.focus({ preventScroll: true }); }, [seeded]);

    const ready = canRead(text, atLimit, cowork);
    const { quick, prepareTest } = useQuickTest(advanced, text, setStarting);
    const go = async () => {
        if (!ready) return;
        const created = await cowork.submit(text, { modelTier: selectedTier, prepareTest: quick ? prepareTest : undefined });
        setStarting(false);
        if (created) { setText(''); onCreated(created); }
    };
    const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); }
    };
    const edit = (next: string) => {
        setText(next);
        if (next.trim()) { if (cowork.draft) reread.edit(next); }
        else close();
    };
    const start = async (payload: CoworkPayload | CoworkTriggerPayload) => {
        stop();
        setStarting(true);
        const created = await cowork.start(payload.agentId ? payload : { ...payload, modelTier: selectedTier });
        setStarting(false);
        if (!created) return;
        setText('');
        setAdvanced(false);
        setChoices({});
        onCreated(created);
    };

    return { advanced, setAdvanced, text, box, choices, setChoices, selectedTier, setSelectedTier, modelTiers, cowork, reread, starting,
        quick, ready, go, onKey, edit, start, close, setText };
}

function BriefEditor({ review, children, t }: { review: boolean; children: ReactNode; t: TranslateFn }) {
    return <details open={!review} className={review ? 'rounded-lg border border-[var(--border-subtle)]' : ''}>
        <summary className={review ? 'cursor-pointer px-4 py-2.5 text-[13px] font-medium' : 'hidden'}>
            {t('cowork_home.activity.edit_brief', 'Edit task instructions')}
        </summary>
        {children}
    </details>;
}

function TaskEditor({ props, brief, t }: { props: CoworkHomeComposerProps; brief: ReturnType<typeof useTaskBrief>; t: TranslateFn }) {
    const { atLimit, maxItems, stepTypes, onTemplates } = props;
    const { advanced, setAdvanced, text, box, choices, setChoices, selectedTier, setSelectedTier, modelTiers, cowork, reread,
        quick, ready, go, onKey, edit, start, close, setText } = brief;
    return (
        <section aria-labelledby="cowork-ask-heading" className="flex flex-col gap-4">
            <h1 id="cowork-ask-heading" className={cowork.draft ? 'sr-only' : 'm-0 text-[24px] sm:text-[28px] leading-tight tracking-tight font-semibold text-[var(--text-primary)]'}>
                {t('cowork_home.ask', 'What should be done for you?')}
            </h1>
            {(!cowork.draft || advanced) && <BriefEditor review={!!cowork.draft} t={t}>
                <form className={`${CARD} overflow-hidden flex flex-col focus-within:ring-2 focus-within:ring-[var(--focus-ring)]`} data-tour="cowork-composer" onSubmit={(e) => { e.preventDefault(); go(); }}>
                    <label htmlFor="cowork-brief" className="px-4 pt-4 sm:px-5 text-[13px] font-semibold text-[var(--text-secondary)]">{t('cowork_home.brief_label', 'Task instructions')}</label>
                    <textarea
                        id="cowork-brief"
                        ref={box}
                        rows={4}
                        value={text}
                        data-testid="cowork-brief-input"
                        onChange={(e) => edit(e.target.value)}
                        onKeyDown={onKey}
                        placeholder={t('cowork_home.brief_placeholder', 'Every Monday at 09:00, summarise last week’s meetings and send it to me')}
                        className="w-full px-4 pt-2 pb-4 sm:px-5 min-h-32 max-h-[50vh] [field-sizing:content] overflow-y-auto resize-y border-0 bg-transparent text-[16px] leading-6 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]"
                    />
                    <div className="grid grid-cols-[1fr_auto] items-start gap-2 border-t border-[var(--border-subtle)] px-4 py-2">
                        <details className="min-w-0" open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
                            <summary className="w-fit cursor-pointer py-2 text-[13px] text-[var(--text-secondary)]">{t('cowork_overview.advanced', 'Advanced')}</summary>
                            {!atLimit && <CoworkStepPicker types={stepTypes} t={t} onPick={(label) => {
                                edit([text.trimEnd(), t('cowork_home.use_step', 'Use the {step} step.', { step: label })].filter(Boolean).join('\n'));
                                box.current?.focus();
                            }} />}
                            {Object.keys(modelTiers).length > 0 && <CoworkModelPicker tiers={modelTiers} value={selectedTier} onChange={setSelectedTier} t={t} />}
                        </details>
                        {!cowork.draft && <button type="submit" className={BUTTON_PRIMARY} data-testid="cowork-continue" disabled={!ready}>{quick ? t('cowork_home.confirm.set_up', 'Set up and test') : t('cowork_home.show_understood', 'Preview task')}</button>}
                    </div>
                </form>
            </BriefEditor>}
            {showExamples(atLimit, text, cowork) && <details><summary className="w-fit cursor-pointer text-[13px] text-[var(--text-secondary)]">{t('cowork_home.from_template', 'Start from a template')}</summary>
                <CoworkExamples onPick={(brief) => { setText(brief); setChoices({}); box.current?.focus(); }} t={t} />
                <button className={LINK_BUTTON} onClick={onTemplates}>{t('cowork_home.activity.all_templates', 'All templates')}</button>
            </details>}
            {atLimit && <p role="status" className={META}>{t('cowork_home.at_limit', 'You have {count} tasks, the most you can have. Delete one to add another.', { count: maxItems })}</p>}
            {cowork.error && !cowork.draft && <p role="alert" className={ALERT}>{cowork.error}</p>}
            {cowork.draft && (
                <CoworkConfirmCard
                    advanced={advanced} onAdvanced={() => setAdvanced(!advanced)} cowork={cowork} sentence={text} choices={choices} rereading={reread.waiting || cowork.submitting}
                    onChoose={(change) => setChoices((was) => ({ ...was, ...change }))}
                    onClarify={(detail) => edit(text.trimEnd() + '\n' + detail)}
                    onStart={(payload) => { void start(payload); }} onCancel={close}
                />
            )}
        </section>
    );
}

export default function CoworkHomeComposer(props: CoworkHomeComposerProps) {
    const { t } = useTranslation();
    const brief = useTaskBrief(props);
    const { setup, finished } = props;
    const scene = finished ? 'finished' : setup || brief.starting ? 'setup' : brief.cowork.draft ? 'review' : brief.cowork.submitting ? 'preview' : 'write';
    let content: ReactNode;
    if (finished) content = <CoworkActivity title={finished.title} message={finished.message} tone="rest" work={{ apps: finished.apps, flow: finished.flow }}>
        <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            <button type="button" className={BUTTON_PRIMARY} onClick={finished.onOpen}>{t('cowork_home.activity.open', 'Open task')}</button>
            <button type="button" className={LINK_BUTTON} onClick={finished.onReset}>{t('cowork_home.activity.another', 'Create another task')}</button>
        </div>
    </CoworkActivity>;
    else if (setup) content = <CoworkActivity title={setup.title} {...setupActivity(setup.phase, t, setup.step, setup.apps, setup.flow)} testId="cowork-setup" />;
    else if (brief.starting) content = <CoworkActivity work={{ action: 'creating', apps: brief.cowork.draft?.payload.enabledApps }} title={brief.cowork.draft?.payload.title} message={t('cowork_home.activity.creating', 'Creating your task…')} />;
    else if (scene === 'preview') content = <CoworkActivity message={brief.quick ? t('cowork_home.activity.thinking', 'Thinking through your task…') : t('cowork_home.activity.preview', 'Preparing your task preview…')} />;
    else content = <TaskEditor props={props} brief={brief} t={t} />;
    return <div data-cowork-engaged={scene !== 'write'}><CoworkSurface scene={scene}>{content}</CoworkSurface></div>;
}
