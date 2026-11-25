/**
 * The cards of ./CoworkNeedCard.tsx about how a task works: with fixed steps, or with the AI working it out every run.
 * Cowork never makes that choice for its owner.
 *
 *   setup      Cowork could not set up the steps of a new task (why, as a class), or its owner left before it
 *              finished. The task waits. "Try setting up again" makes the steps once more and tests them; "Let the AI
 *              work it out every run" releases it without steps.
 *   AiChosen   what any card shows right after "Let the AI work it out every run": that it is so, and Undo for a few
 *              seconds, which puts back the steps, their approval and the card it came from (PUT /api/cowork/:id/setup,
 *              ../../api/coworkSetup.ts). Without Undo the choice stands and the card goes.
 */
import { useEffect, useRef, useState } from 'react';
import CoworkActivity, { setupMessage } from './CoworkActivity';
import type { PlanMakeProgress } from '@/api/coworkPlan.types';
import { NeedFrame, useNeedAct, type NeedKindProps } from './CoworkNeedFrame';
import { PILL_PRIMARY, PILL_QUIET } from './coworkUi';
import { makeCoworkPlan } from '@/api/coworkPlanMake';
import { chooseCoworkSetup } from '@/api/coworkSetup';
import type { CoworkSetupCause } from '@/api/cowork.types';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';

/** How long Undo is offered after "Let the AI work it out every run". */
const UNDO_MS = 8000;

/** The task is the AI's now: say so, and offer Undo for a few seconds. `onBack`: Undo worked, show the card again. */
export function AiChosen({ need, solo, onOpenTask, onDone, onBack }: NeedKindProps & { onBack: () => void }) {
    const { t } = useTranslation();
    const act = useNeedAct(onDone);
    const { mutate } = act;
    const stands = t('cowork_home.done.ai_every_run', 'From now on the AI works it out on every run.');
    // Without Undo the choice stands: Cowork is read again, and the card goes with its need.
    useEffect(() => {
        const timer = setTimeout(() => mutate({ run: async () => null, done: stands }), UNDO_MS);
        return () => clearTimeout(timer);
    }, [mutate, stands]);
    const actions = (
        <button type="button" className={PILL_QUIET} disabled={act.isPending} onClick={() => act.mutate({ run: async () => { await chooseCoworkSetup(need.itemId, 'steps'); onBack(); }, settle: false })}>
            {t('cowork_home.need.undo', 'Undo')}
        </button>
    );
    return (
        <NeedFrame
            need={need} solo={solo} onOpenTask={onOpenTask} actions={actions} error={act.error}
            title={t('cowork_home.need.ai_chosen', 'The AI works this task out on every run from now on.')}
            sub={t('cowork_home.need.ai_chosen_sub', 'Changed your mind? Undo puts everything back as it was.')}
        />
    );
}

/**
 * "Let the AI work it out every run", for any card: `choose` asks the server and then shows `AiChosen` in the card's
 * place; `chosen` says it is showing, `back` returns to the card (Undo worked).
 */
export function useAiChoice(itemId: string, act: ReturnType<typeof useNeedAct>) {
    const [chosen, setChosen] = useState(false);
    const choose = () => act.mutate({ run: async () => { await chooseCoworkSetup(itemId, 'ai'); setChosen(true); }, settle: false });
    return { chosen, choose, back: () => setChosen(false) };
}

const CAUSE: Readonly<Record<CoworkSetupCause, readonly [string, string]>> = {
    no_model: ['cowork_home.setup_card.no_model', 'Your workspace has no AI model for this yet. Ask your administrator, then try again.'],
    not_available: ['cowork_home.setup_card.not_available', 'Fixed steps are not part of your organisation’s Bee Flow.'],
    timeout: ['cowork_home.setup_card.timeout', 'It took too long. Try again, or say the task in a shorter sentence.'],
    unclear: ['cowork_home.setup_card.unclear', 'Cowork could not turn the sentence into steps. Try again, or say it step by step.'],
    budget: ['cowork_home.setup_card.budget', 'The AI budget for this month is used up.'],
    left: ['cowork_home.setup_card.left', 'It was not finished: the page was closed while Cowork was setting up.'],
    failed: ['cowork_home.setup_card.failed', 'Something went wrong while setting up. Nothing was sent.'],
};

/** Setting the steps up again, from the card: its phases while it runs, and a stop when the card goes. */
function useSetUpAgain(itemId: string, t: TranslateFn) {
    const running = useRef<AbortController | null>(null);
    const [phase, setPhase] = useState<PlanMakeProgress['phase'] | null>(null);
    useEffect(() => () => running.current?.abort(), []);
    const run = async () => {
        const control = new AbortController();
        running.current = control;
        setPhase('thinking');
        try {
            const outcome = await makeCoworkPlan(itemId, { signal: control.signal, onProgress: (p) => setPhase(p.phase) });
            if (outcome.error !== null) throw new Error(t('cowork_home.setup_card.again_failed', 'That did not work this time either. The task keeps waiting for you.'));
        } finally {
            setPhase(null);
        }
    };
    return { run, phase };
}

/** Cowork could not set up the steps: try again, or let the AI work it out every run. Never chosen for the owner. */
export function SetupCard(props: NeedKindProps) {
    const { need, onDone } = props;
    const { t } = useTranslation();
    const act = useNeedAct(onDone);
    const ai = useAiChoice(need.itemId, act);
    const again = useSetUpAgain(need.itemId, t);
    if (ai.chosen) return <AiChosen {...props} onBack={ai.back} />;
    const [key, en] = CAUSE[need.cause ?? 'failed'] ?? CAUSE.failed;
    if (again.phase) return <CoworkActivity title={need.title} message={setupMessage(again.phase, t)} testId="cowork-setup-again" />;
    const actions = (
        <>
            <button type="button" className={PILL_PRIMARY} disabled={act.isPending} onClick={() => act.mutate({ run: again.run, done: t('cowork_home.setup.done', 'The steps are ready and tested. Open and approve them under Needs you.') })}>
                {t('cowork_home.setup_card.again', 'Try setting up again')}
            </button>
            <button type="button" className={PILL_QUIET} disabled={act.isPending} onClick={ai.choose}>{t('cowork_home.fix.ai_every_run', 'Let the AI work it out every run')}</button>
        </>
    );
    return (
        <NeedFrame
            {...props} actions={actions} error={act.error}
            title={t('cowork_home.setup_card.title', 'Cowork could not set up the steps.')}
            sub={`${t(key, en)} ${t('cowork_home.setup_card.waits', 'Until you choose, this task does not run.')}`}

        />
    );
}
