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
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import CoworkExamples from './CoworkExamples';
import CoworkConfirmCard from './CoworkConfirmCard';
import CoworkProgress from './CoworkProgress';
import type { ConfirmChoices } from './coworkConfirmModel';
import { takeHandedBrief } from './coworkHandedBrief';
import { ENTER } from './coworkMotion';
import { ALERT, BUTTON_PRIMARY, CARD, LINK_BUTTON, META } from './coworkUi';
import useCoworkComposer, { type UseCoworkComposerReturn } from './useCoworkComposer';
import type { TaskSetup } from './useTaskSetup';
import TierSlider from '../licensing/TierSlider';
import useModelTierSelection from '@/hooks/useModelTierSelection';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import type { CoworkItem, CoworkPayload, CoworkTriggerPayload } from '@/api/cowork.types';

export interface CoworkHomeComposerProps {
    /** No room for another task: the box says so instead of offering to read the sentence. */
    atLimit: boolean;
    maxItems: number;
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

function SetupProgress({ setup, t }: { setup: TaskSetup; t: TranslateFn }) {
    const labels = [t('cowork_home.setup.steps', 'Setting up the steps'), t('cowork_home.setup.testing', 'Testing once, nothing is sent'), t('cowork_home.setup.check', 'Ready for your check')];
    return (
        <div className={`${CARD} ${ENTER} p-4 flex flex-col gap-3`} data-testid="cowork-setup">
            <p className="m-0 text-[16px] leading-6 font-semibold text-[var(--text-primary)]">{setup.title}</p>
            <CoworkProgress labels={labels} phase={setup.phase} />
        </div>
    );
}

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
function ComposerButtons({ reading, disabled, onTemplates, t }: { reading: boolean; disabled: boolean; onTemplates: () => void; t: TranslateFn }) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-2 sm:px-5">
            <button type="button" className={LINK_BUTTON} onClick={onTemplates}>{t('cowork_home.from_template', 'Start from a template')}</button>
            <button type="submit" className={BUTTON_PRIMARY} data-testid="cowork-continue" disabled={disabled}>
                {reading ? t('cowork_home.reading', 'Reading…') : t('cowork_home.show_understood', 'Show what I understood')}
            </button>
        </div>
    );
}

function canRead(text: string, atLimit: boolean, cowork: UseCoworkComposerReturn) {
    return !!text.trim() && !atLimit && !cowork.draft && !cowork.submitting;
}

function showExamples(atLimit: boolean, text: string, cowork: UseCoworkComposerReturn) {
    return !atLimit && !text && !cowork.draft;
}

export default function CoworkHomeComposer({ atLimit, maxItems, seed = null, onTemplates, onCreated, setup }: CoworkHomeComposerProps) {
    const { t } = useTranslation();
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
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
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

    return (
        <section aria-labelledby="cowork-ask-heading" className="flex flex-col gap-4">
            <h1 id="cowork-ask-heading" className="m-0 text-[24px] sm:text-[28px] leading-tight tracking-tight font-semibold text-[var(--text-primary)]">
                {t('cowork_home.ask', 'What should be done for you?')}
            </h1>
            <form className={`${CARD} overflow-hidden flex flex-col focus-within:ring-2 focus-within:ring-[var(--focus-ring)]`} data-tour="cowork-composer" onSubmit={(e) => { e.preventDefault(); go(); }}>
                <label htmlFor="cowork-brief" className="sr-only">{t('cowork_home.brief_label', 'Describe the task in one sentence')}</label>
                <textarea
                    id="cowork-brief"
                    ref={box}
                    rows={2}
                    value={text}
                    data-testid="cowork-brief-input"
                    onChange={(e) => edit(e.target.value)}
                    onKeyDown={onKey}
                    placeholder={t('cowork_home.brief_placeholder', 'Every Monday at 09:00, summarise last week’s meetings and send it to me')}
                    className="w-full px-4 pt-4 pb-3 sm:px-5 min-h-[88px] resize-none border-0 bg-transparent text-[16px] leading-6 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]"
                />
                {Object.keys(modelTiers).length > 0 && <div className="px-4 pb-2"><TierSlider tiers={modelTiers} value={selectedTier} onChange={setSelectedTier} variant="input" /></div>}
                <ComposerButtons reading={cowork.submitting && !cowork.draft} disabled={!ready} onTemplates={onTemplates} t={t} />
            </form>
            {showExamples(atLimit, text, cowork) && <CoworkExamples onPick={(brief, supplierFilter) => { setText(brief); setChoices(supplierFilter ? { recipients: { me: true, others: [] } } : {}); box.current?.focus(); }} t={t} />}
            {atLimit && <p role="status" className={META}>{t('cowork_home.at_limit', 'You have {count} tasks, the most you can have. Delete one to add another.', { count: maxItems })}</p>}
            {cowork.error && !cowork.draft && <p role="alert" className={ALERT}>{cowork.error}</p>}
            {cowork.draft && (
                <CoworkConfirmCard
                    cowork={cowork} sentence={text} choices={choices} rereading={reread.waiting || (cowork.submitting && !starting)}
                    onChoose={(change) => setChoices((was) => ({ ...was, ...change }))}
                    onClarify={(detail) => edit(text.trimEnd() + '\n' + detail)}
                    onStart={(payload) => { void start(payload); }} onCancel={close}
                />
            )}
            {setup && <SetupProgress setup={setup} t={t} />}
        </section>
    );
}
