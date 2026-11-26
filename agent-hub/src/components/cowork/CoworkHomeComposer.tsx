/**
 * The home composer starts a fixed task's held test directly when the brief provides everything it needs.
 * Advanced opens the editable preview. The orb asks for missing details. Workspaces without fixed
 * steps always confirm before creating the task. Setup progress ends with the result ready for review.
 *
 * Editing the sentence while the card is open does not throw the card away: a moment after the last keystroke the
 * sentence is read again and the card's rows follow it, except the ones the owner already changed by hand
 * (`choices`, kept here so they outlive the draft). An emptied box closes the card.
 *
 * A sentence handed over by "Make it a task" in the chat (./coworkHandedBrief.ts) fills the box once, set to run every
 * week on the day it was asked; a template's sentence (`seed`) fills it too.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import CoworkBeeInput, { type HomeDestinations } from './CoworkBeeInput';
import CoworkStepPicker from './CoworkStepPicker';
import CoworkExistingTasks, { ExistingSubmit, useExistingTaskAction } from './CoworkExistingTasks';
import { type ExampleId, useExampleAccess } from './coworkExampleAccess';
import CoworkExamples from './CoworkExamples';
import CoworkConfirmCard, { useMayHaveSteps } from './CoworkConfirmCard';
import CoworkOrb from './CoworkOrb';
import CoworkSurface from './CoworkSurface';
import CoworkActivity, { setupActivity } from './CoworkActivity';
import { canTestDraft, confirmView, isClockPayload, missingDestination, needsScheduleAnswer, startPayload, type ConfirmChoices } from './coworkConfirmModel';
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
    guided?: boolean;
    destinations?: HomeDestinations;
    openTask?: (id: string) => void;
    items?: CoworkItem[];
    onAskTask?: (id: string, message: string, shared?: boolean) => void;
    /** No room for another task: the box says so instead of offering to read the sentence. */
    atLimit: boolean;
    maxItems: number;
    stepTypes?: string[];
    /** A sentence to put in the box (a template's), with a counter so the same one can be put twice. */
    seed?: import('./coworkSheetPanels').ComposerSeed | null;
    onTemplates: () => void;
    /** A task was created: set up and test its steps. */
    onCreated: (item: CoworkItem) => void;
    /** The task whose steps are being set up now, if any. */
    setup: TaskSetup | null;

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

/** Start the held test once all required choices are known. */
function useQuickTest(advanced: boolean, choices: ConfirmChoices, setStarting: (value: boolean) => void) {
    const mayTest = useMayHaveSteps();
    const quick = mayTest && !advanced;
    const { availableApps } = useCoworkApps();
    const prepareTest = (draft: CoworkDraft, sentence: string): CoworkPayload | null => {
        if (!draft.spec || draft.spec.clarification || !canTestDraft(draft.payload)) return null;
        const view = confirmView(draft, choices, sentence, availableApps.filter(app => !app.isStep));
        if (missingDestination(draft, view, choices) || (!choices.schedule && needsScheduleAnswer(draft))) return null;
        const payload = startPayload(view, true);
        if (!isClockPayload(payload)) return null;
        setStarting(true);
        return payload;
    };
    return { quick, prepareTest };
}

function useBriefSeed(seed: CoworkHomeComposerProps['seed'], setText: (value: string) => void, close: () => void) {
    const box = useRef<HTMLTextAreaElement>(null);
    // A new seed fills the box (state from a newer input, set while rendering); the focus follows it after.
    const [seeded, setSeeded] = useState(seed);
    if (seed !== seeded) {
        setSeeded(seed);
        if (seed) { setText(seed.text); close(); }
    }
    useEffect(() => { if (seeded) box.current?.focus({ preventScroll: true }); }, [seeded]);

    return box;
}

function useTaskBrief({ guided, atLimit, seed = null, onCreated }: CoworkHomeComposerProps) {
    const [handed] = useState(takeHandedBrief);
    const [text, setText] = useState(handed.brief);
    const [choices, setChoices] = useState<ConfirmChoices>({});
    const [advanced, setAdvanced] = useState(false);
    const [starting, setStarting] = useState(false);
    const { selectedTier, setSelectedTier, modelTiers } = useModelTierSelection({ storageKey: 'coworkPreferredTier', legacyStorageKey: 'coworkTier', defaultTier: 'thinking', taskType: 'automation' });
    const cowork = useCoworkComposer({ confirm: true, weeklyOn: handed.weekday });
    const { stop, ...reread } = useReread(cowork, selectedTier);
    const { reset } = cowork;
    const close = useCallback(() => { stop(); setChoices({}); setAdvanced(false); reset(); }, [stop, reset]);

    const box = useBriefSeed(seed, setText, close);
    const ready = canRead(text, atLimit, cowork);
    const { quick, prepareTest } = useQuickTest(!guided && advanced, choices, setStarting);
    const pending = useRef(false);
    const perform = async (request: () => Promise<CoworkItem | null>) => {
        if (pending.current) return;
        pending.current = true;
        try {
            const item = await request();
            if (item) { setText(''); setAdvanced(false); setChoices({}); onCreated(item); }
        } finally {
            pending.current = false;
            setStarting(false);
        }
    };
    const submitBrief = (sentence: string) => perform(() => cowork.submit(sentence, {
        modelTier: selectedTier,
        prepareTest: quick ? draft => prepareTest(draft, sentence) : undefined,
    }));
    const go = (sentence = text) => { if (canRead(sentence, atLimit, cowork)) { setText(sentence); void submitBrief(sentence); } };
    const clarify = (detail: string) => {
        const sentence = text.trimEnd() + '\n' + detail;
        stop();
        setText(sentence);
        void submitBrief(sentence);
    };
    const edit = (next: string) => {
        setText(next);
        if (next.trim()) { if (cowork.draft) reread.edit(next); }
        else close();
    };
    const start = (payload: CoworkPayload | CoworkTriggerPayload) => perform(() => {
        stop();
        setStarting(true);
        return cowork.start(payload.agentId ? payload : { ...payload, modelTier: selectedTier });
    });

    return { advanced, setAdvanced, text, box, choices, setChoices, selectedTier, setSelectedTier, modelTiers, cowork, reread, starting,
        quick, ready, go, edit, clarify, start, close, setText };
}

function BriefEditor({ review, children, t }: { review: boolean; children: ReactNode; t: TranslateFn }) {
    return <details open={!review} className={review ? 'rounded-lg border border-[var(--border-subtle)]' : ''}>
        <summary className={review ? 'cursor-pointer px-4 py-2.5 text-[13px] font-medium' : 'hidden'}>
            {t('cowork_home.activity.edit_brief', 'Edit task instructions')}
        </summary>
        {children}
    </details>;
}

interface EditorProps { props: CoworkHomeComposerProps; brief: ReturnType<typeof useTaskBrief>; t: TranslateFn }

function BriefForm({ props: { atLimit, stepTypes, items = [], onAskTask }, brief, t }: EditorProps) {
    const { advanced, setAdvanced, text, box, selectedTier, setSelectedTier, modelTiers, cowork, quick, ready, go, edit } = brief;
    const action = useExistingTaskAction(items, text, cowork.draft ? undefined : onAskTask);
    const submit = action.editing ? action.submit : () => go();
    return <BriefEditor review={!!cowork.draft} t={t}>
        <form className={`${CARD} overflow-hidden flex flex-col focus-within:ring-2 focus-within:ring-[var(--focus-ring)]`} data-tour="cowork-composer" onSubmit={(e) => { e.preventDefault(); submit(); }}>
            <label htmlFor="cowork-brief" className="px-4 pt-4 sm:px-5 text-[13px] font-semibold text-[var(--text-secondary)]">{t('cowork_home.brief_label', 'Task instructions')}</label>
            <textarea
                id="cowork-brief"
                ref={box}
                rows={4}
                value={text}
                data-testid="cowork-brief-input"
                onChange={(e) => edit(e.target.value)}
                onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); submit(); } }}
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
                {action.editing && <div className="flex flex-wrap justify-end items-center gap-2">
                    <button type="button" className={LINK_BUTTON} disabled={!ready} onClick={() => go()}>{t('cowork_home.existing.create_new', 'Create a new task')}</button>
                    <ExistingSubmit action={action} />
                </div>}
                {!action.editing && !cowork.draft && <button type="submit" className={BUTTON_PRIMARY} data-testid="cowork-continue" disabled={!ready}>{quick ? t('cowork_home.confirm.set_up', 'Set up and test') : t('cowork_home.show_understood', 'Preview task')}</button>}
            </div>
        </form>
        <CoworkExistingTasks action={action} />
    </BriefEditor>;
}

function TaskHeading({ welcome, t }: { welcome: boolean; t: TranslateFn }) {
    return <>
            {welcome && <div className="cowork-welcome-orb"><CoworkOrb tone="rest" /></div>}
            <h1 id="cowork-ask-heading" className={welcome ? 'm-0 text-center text-[24px] sm:text-[28px] leading-tight tracking-tight font-semibold text-[var(--text-primary)]' : 'sr-only'}>
                {t('cowork_home.ask', 'What should be done for you?')}
            </h1>
    </>;
}

function useExamplePicker(offerExamples: boolean) {
    const [example, selectExample] = useState<ExampleId | null>(null);
    const [templatesOpen, setTemplatesOpen] = useState(false);
    const access = useExampleAccess(offerExamples && templatesOpen);
    const askingExample = offerExamples && example !== null && access.ids.has(example);
    return { example, selectExample, access, askingExample, setTemplatesOpen };
}

function TaskEditor(editor: EditorProps) {
    const { props, brief } = editor;
    if (props.guided && !brief.cowork.draft) {
        return <CoworkBeeInput seed={props.seed} key={props.destinations?.context} text={brief.text} edit={brief.edit} go={brief.go} inputRef={brief.box}
            destinations={props.destinations} tier={brief.selectedTier} items={props.items ?? []} ask={props.onAskTask} open={props.openTask} error={brief.cowork.error} atLimit={props.atLimit} />;
    }
    return <TaskReviewEditor {...editor} />;
}

function TaskReviewEditor({ props, brief, t }: EditorProps) {
    const { atLimit, maxItems, onTemplates } = props;
    const offerExamples = showExamples(atLimit, brief.text, brief.cowork);
    const { example, selectExample, access, askingExample, setTemplatesOpen } = useExamplePicker(offerExamples);
    const { setAdvanced, box, choices, setChoices, cowork, reread, clarify, start, close, setText } = brief;
    const advanced = props.guided ? false : brief.advanced;
    return (
        <section data-cowork-engaged={askingExample} aria-labelledby="cowork-ask-heading" className="flex flex-col gap-4">
            <TaskHeading welcome={!cowork.draft && !askingExample} t={t} />
            {!askingExample && (!cowork.draft || advanced) && <BriefForm props={props} brief={brief} t={t} />}
            {offerExamples && <details onToggle={event => setTemplatesOpen(event.currentTarget.open)}><summary className={askingExample ? 'hidden' : 'w-fit cursor-pointer text-[13px] text-[var(--text-secondary)]'}>{t('cowork_home.from_template', 'Start from a template')}</summary>
                <CoworkExamples key={JSON.stringify([Array.from(access.ids), access.mail.map(app => app.id), access.tables.map(table => table.id)])} access={access} selected={example} select={selectExample} onPick={(brief) => { setText(brief); setChoices({}); box.current?.focus(); }} t={t} />
                {!askingExample && <button className={LINK_BUTTON} onClick={onTemplates}>{t('cowork_home.activity.all_templates', 'All templates')}</button>}
            </details>}
            {atLimit && <p role="status" className={META}>{t('cowork_home.at_limit', 'You have {count} tasks, the most you can have. Delete one to add another.', { count: maxItems })}</p>}
            {cowork.error && !cowork.draft && <p role="alert" className={ALERT}>{cowork.error}</p>}
            {cowork.draft && (
                <CoworkConfirmCard
                    advanced={advanced} onAdvanced={() => setAdvanced(!advanced)} cowork={cowork} sentence={brief.text} choices={choices} rereading={reread.waiting || cowork.submitting}
                    onChoose={(change) => setChoices((was) => ({ ...was, ...change }))}
                    onClarify={clarify}
                    onStart={(payload) => { void start(payload); }} onCancel={close}
                />
            )}
        </section>
    );
}

export default function CoworkHomeComposer(props: CoworkHomeComposerProps) {
    const { t } = useTranslation();
    const brief = useTaskBrief(props);
    const { setup } = props;
    const scene = setup || brief.starting ? 'setup' : brief.cowork.draft ? 'review' : brief.cowork.submitting ? 'preview' : 'write';
    let content: ReactNode;
    if (setup) content = <CoworkActivity title={setup.title} {...setupActivity(setup.phase, t, setup.step, setup.apps, setup.flow)} testId="cowork-setup" />;
    else if (brief.starting) content = <CoworkActivity work={{ action: 'creating', apps: brief.cowork.draft?.payload.enabledApps }} title={brief.cowork.draft?.payload.title} message={t('cowork_home.activity.creating', 'I’m putting your task together.')} />;
    else if (scene === 'preview') content = <CoworkActivity message={brief.quick ? t('cowork_home.activity.thinking', 'I’m working out what your task needs.') : t('cowork_home.activity.preview', 'I’m preparing an outline for you to review.')} />;
    else content = <TaskEditor props={props} brief={brief} t={t} />;
    return <div data-cowork-engaged={scene !== 'write'}><CoworkSurface scene={scene}>{content}</CoworkSurface></div>;
}
