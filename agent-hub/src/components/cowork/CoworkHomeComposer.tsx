/**
 * The top of the Cowork home: "What should be done for you?", one sentence, "Start from a template" and Continue.
 * Continue lets the server work the sentence out (./useCoworkComposer.ts with `confirm`) and shows the ONE
 * confirmation card (./CoworkConfirmCard.tsx); Start creates the task, and Cowork then sets up its steps and tests them
 * once (./useTaskSetup.ts), shown here as a progress that ends in a check under Needs you.
 *
 * A sentence handed over by "Make it a task" in the chat (./coworkHandedBrief.ts) fills the box once, set to run every
 * week on the day it was asked; a template's sentence (`seed`) fills it too.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import CoworkConfirmCard from './CoworkConfirmCard';
import CoworkProgress from './CoworkProgress';
import { takeHandedBrief } from './coworkHandedBrief';
import { CARD, LINK_BUTTON, PILL_PRIMARY } from './coworkUi';
import useCoworkComposer from './useCoworkComposer';
import type { TaskSetup } from './useTaskSetup';
import useModelTierSelection from '@/hooks/useModelTierSelection';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import type { CoworkItem } from '@/api/cowork.types';

export interface CoworkHomeComposerProps {
    /** No room for another task: the box says so instead of offering Continue. */
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

function SetupProgress({ setup, t }: { setup: TaskSetup; t: TranslateFn }) {
    const labels = [t('cowork_home.setup.steps', 'Setting up the steps'), t('cowork_home.setup.testing', 'Testing once, nothing is sent'), t('cowork_home.setup.check', 'Ready for your check')];
    return (
        <div className={`${CARD} p-[18px] flex flex-col gap-3`} data-testid="cowork-setup">
            <p className="text-[16px] font-semibold text-[var(--text-primary)]">{setup.title}</p>
            <CoworkProgress labels={labels} phase={setup.phase} />
        </div>
    );
}

export default function CoworkHomeComposer({ atLimit, maxItems, seed = null, onTemplates, onCreated, setup }: CoworkHomeComposerProps) {
    const { t } = useTranslation();
    const [handed] = useState(takeHandedBrief);
    const [text, setText] = useState(handed.brief);
    const box = useRef<HTMLTextAreaElement>(null);
    const { selectedTier } = useModelTierSelection({ storageKey: 'coworkTier' });
    const cowork = useCoworkComposer({ confirm: true, weeklyOn: handed.weekday });
    const { reset } = cowork;

    // A new seed fills the box (state from a newer input, set while rendering); the focus follows it after.
    const [seeded, setSeeded] = useState(seed);
    if (seed !== seeded) {
        setSeeded(seed);
        if (seed) { setText(seed.text); reset(); }
    }
    useEffect(() => { if (seeded) box.current?.focus({ preventScroll: true }); }, [seeded]);

    const go = () => { if (text.trim() && !atLimit && !cowork.draft) void cowork.submit(text, { modelTier: selectedTier }); };
    const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); go(); }
    };
    const start = async () => {
        const created = await cowork.start();
        if (!created) return;
        setText('');
        onCreated(created);
    };

    return (
        <section aria-labelledby="cowork-ask-heading" className="flex flex-col gap-4">
            <h1 id="cowork-ask-heading" className="text-[25px] sm:text-[26px] font-semibold tracking-[-0.015em] text-[var(--text-primary)]">
                {t('cowork_home.ask', 'What should be done for you?')}
            </h1>
            <form className={`${CARD} px-[18px] pt-[18px] pb-3 flex flex-col gap-2`} onSubmit={(e) => { e.preventDefault(); go(); }}>
                <label htmlFor="cowork-brief" className="sr-only">{t('cowork_home.brief_label', 'Describe the task in one sentence')}</label>
                <textarea
                    id="cowork-brief"
                    ref={box}
                    rows={2}
                    value={text}
                    data-testid="cowork-brief-input"
                    onChange={(e) => { setText(e.target.value); if (cowork.draft) reset(); }}
                    onKeyDown={onKey}
                    placeholder={t('cowork_home.brief_placeholder', 'Every Monday at 09:00, summarise last week’s meetings and send it to me')}
                    className="w-full min-h-[54px] resize-none border-0 bg-transparent text-[17px] leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
                />
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                    <button type="button" className={LINK_BUTTON} onClick={onTemplates}>{t('cowork_home.from_template', 'Start from a template')}</button>
                    <button type="submit" className={PILL_PRIMARY} data-testid="cowork-continue" disabled={!text.trim() || !!cowork.draft || cowork.submitting || atLimit}>
                        {cowork.submitting && !cowork.draft ? t('cowork_home.reading', 'Reading…') : t('cowork_home.continue', 'Continue')}
                    </button>
                </div>
            </form>
            {atLimit && <p role="status" className="text-[14px] text-[var(--text-tertiary)]">{t('cowork_home.at_limit', 'You have {count} tasks, the most you can have. Delete one to add another.', { count: maxItems })}</p>}
            {cowork.error && !cowork.draft && <p role="alert" className="text-[13px] text-[var(--error-ink)]">{cowork.error}</p>}
            {cowork.draft && <CoworkConfirmCard cowork={cowork} onStart={() => { void start(); }} />}
            {setup && <SetupProgress setup={setup} t={t} />}
        </section>
    );
}
