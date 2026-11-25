/**
 * The top of the Cowork home: "What should be done for you?", one sentence, "Start from a template" and "Show what I
 * understood". That lets the server work the sentence out (./useCoworkComposer.ts with `confirm`) and shows the ONE
 * confirmation card (./CoworkConfirmCard.tsx), whose four rows can all be changed; "Set up and test" creates the task
 * with what the card shows, and Cowork then sets up its steps and tests them once (./useTaskSetup.ts), shown here as a
 * progress that ends in a check under Needs you.
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
import CoworkConfirmCard from './CoworkConfirmCard';
import CoworkActivity, { setupMessage } from './CoworkActivity';
import type { ConfirmChoices } from './coworkConfirmModel';
import { takeHandedBrief } from './coworkHandedBrief';
import { ALERT, BUTTON_PRIMARY, CARD, LINK_BUTTON, META } from './coworkUi';
import useCoworkComposer, { type UseCoworkComposerReturn } from './useCoworkComposer';
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

/** Under the box: "Start from a template", and the button that reads the sentence. */
function ComposerButtons({ disabled, previewOpen, onTemplates, t }: { previewOpen: boolean; disabled: boolean; onTemplates: () => void; t: TranslateFn }) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-2 sm:px-5">
            <button type="button" className={LINK_BUTTON} onClick={onTemplates}>{t('cowork_home.from_template', 'Start from a template')}</button>
            {!previewOpen && <button type="submit" className={BUTTON_PRIMARY} data-testid="cowork-continue" disabled={disabled}>
                {t('cowork_home.show_understood', 'Preview task')}
            </button>}
        </div>
    );
}

function canRead(text: string, atLimit: boolean, cowork: UseCoworkComposerReturn) {
    return !!text.trim() && !atLimit && !cowork.draft && !cowork.submitting;
}

function showExamples(atLimit: boolean, text: string, cowork: UseCoworkComposerReturn) {
    return !atLimit && !text && !cowork.draft;
}

function useTaskBrief({ atLimit, seed = null, onCreated }: CoworkHomeComposerProps) {
    const [handed] = useState(takeHandedBrief);
    const [text, setText] = useState(handed.brief);
    const [choices, setChoices] = useState<ConfirmChoices>({});
    const [starting, setStarting] = useState(false);
    const box = useRef<HTMLTextAreaElement>(null);
    const { selectedTier, setSelectedTier, modelTiers } = useModelTierSelection({ storageKey: 'coworkTier', taskType: 'automation' });
    const cowork = useCoworkComposer({ confirm: true, weeklyOn: handed.weekday });
    const reread = useReread(cowork, selectedTier);
    const { reset } = cowork;
    const { stop } = reread;
    const close = useCallback(() => { stop(); setChoices({}); reset(); }, [stop, reset]);

    // A new seed fills the box (state from a newer input, set while rendering); the focus follows it after.
    const [seeded, setSeeded] = useState(seed);
    if (seed !== seeded) {
        setSeeded(seed);
        if (seed) { setText(seed.text); close(); }
    }
    useEffect(() => { if (seeded) box.current?.focus({ preventScroll: true }); }, [seeded]);

    const ready = canRead(text, atLimit, cowork);
    const go = () => { if (ready) void cowork.submit(text, { modelTier: selectedTier }); };
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
        setChoices({});
        onCreated(created);
    };

    return { text, box, choices, setChoices, selectedTier, setSelectedTier, modelTiers, cowork, reread, starting,
        ready, go, onKey, edit, start, close, setText };
}

function BriefEditor({ review, children, t }: { review: boolean; children: ReactNode; t: TranslateFn }) {
    return <details open={!review} className={review ? 'rounded-lg border border-[var(--border-subtle)]' : ''}>
        <summary className={review ? 'cursor-pointer px-4 py-2.5 text-[13px] font-medium' : 'hidden'}>
            {t('cowork_home.activity.edit_brief', 'Edit task instructions')}
        </summary>
        {children}
    </details>;
}

export default function CoworkHomeComposer(props: CoworkHomeComposerProps) {
    const { atLimit, maxItems, stepTypes, onTemplates, setup } = props;
    const { t } = useTranslation();
    const { text, box, choices, setChoices, selectedTier, setSelectedTier, modelTiers, cowork, reread, starting,
        ready, go, onKey, edit, start, close, setText } = useTaskBrief(props);
    if (setup) return <CoworkActivity title={setup.title} message={setupMessage(setup.phase, t)} testId="cowork-setup" />;
    if (starting) return <CoworkActivity title={cowork.draft?.payload.title} message={t('cowork_home.activity.creating', 'Creating your task…')} />;
    if (cowork.submitting && !cowork.draft) return <CoworkActivity message={t('cowork_home.activity.preview', 'Preparing your task preview…')} />;
    return (
        <section aria-labelledby="cowork-ask-heading" className="flex flex-col gap-4">
            <h1 id="cowork-ask-heading" className={cowork.draft ? 'sr-only' : 'm-0 text-[24px] sm:text-[28px] leading-tight tracking-tight font-semibold text-[var(--text-primary)]'}>
                {t('cowork_home.ask', 'What should be done for you?')}
            </h1>
            <BriefEditor review={!!cowork.draft} t={t}>
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
                    {!atLimit && <CoworkStepPicker types={stepTypes} t={t} onPick={(label) => {
                        edit([text.trimEnd(), t('cowork_home.use_step', 'Use the {step} step.', { step: label })].filter(Boolean).join('\n'));
                        box.current?.focus();
                    }} />}
                    {Object.keys(modelTiers).length > 0 && <div className="px-4 pb-2"><CoworkModelPicker tiers={modelTiers} value={selectedTier} onChange={setSelectedTier} t={t} /></div>}
                    <ComposerButtons previewOpen={!!cowork.draft} disabled={!ready} onTemplates={onTemplates} t={t} />
                </form>
            </BriefEditor>
            {showExamples(atLimit, text, cowork) && <CoworkExamples onPick={(brief) => { setText(brief); setChoices({}); box.current?.focus(); }} t={t} />}
            {atLimit && <p role="status" className={META}>{t('cowork_home.at_limit', 'You have {count} tasks, the most you can have. Delete one to add another.', { count: maxItems })}</p>}
            {cowork.error && !cowork.draft && <p role="alert" className={ALERT}>{cowork.error}</p>}
            {cowork.draft && (
                <CoworkConfirmCard
                    cowork={cowork} sentence={text} choices={choices} rereading={reread.waiting || cowork.submitting}
                    onChoose={(change) => setChoices((was) => ({ ...was, ...change }))}
                    onClarify={(detail) => edit(text.trimEnd() + '\n' + detail)}
                    onStart={(payload) => { void start(payload); }} onCancel={close}
                />
            )}
        </section>
    );
}
