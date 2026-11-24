/**
 * The cards of ./CoworkNeedCard.tsx about the task's own steps and its place among colleagues: check the steps, test
 * them once, fix them, sign in again, a desk's invitation and a hand-off. The cards that carry what a run wrote (a
 * message, a review, a repair) are ./CoworkNeedAsks.tsx. Each is one sentence, one primary action and a way out.
 */
import { useState } from 'react';
import { NeedFrame, useNeedAct, type NeedKindProps } from './CoworkNeedFrame';
import type { NeedProblem } from './coworkNeedsModel';
import { PILL_PRIMARY, PILL_QUIET } from './coworkUi';
import { settingsPathForTab } from '@/authedApp/settingsRoutes';
import { deleteCowork, runCoworkNow, toggleCowork } from '@/api/coworkApi';
import { approveCoworkPlan, fixCoworkPlanWiring, removeCoworkPlan, startCoworkPlanTry } from '@/api/coworkPlanApi';
import { useDeskHandOff, useItemDeskActions } from '@/api/coworkDesks';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';

/** The steps are ready: on the home, look at them in the task; inside it, approve them or try them once more. */
export function CheckCard({ need, solo, onOpenTask, onDone }: NeedKindProps) {
    const { t } = useTranslation();
    const act = useNeedAct(onDone);
    const title = need.changed
        ? t('cowork_home.need.check_changed', 'The steps changed and may do more than you approved. Check them again.')
        : t('cowork_home.need.check', 'The steps are ready and tested. Check them once.');
    const fingerprint = need.fingerprint;
    const actions = solo ? (
        <>
            <button type="button" className={PILL_PRIMARY} disabled={act.isPending || !fingerprint} onClick={() => fingerprint && act.mutate({ run: () => approveCoworkPlan(need.itemId, fingerprint), done: t('cowork_home.done.approved', 'Approved. It runs by itself from now on.') })}>
                {t('cowork_home.need.approve_steps', 'Approve the steps')}
            </button>
            <button type="button" className={PILL_QUIET} disabled={act.isPending} onClick={() => act.mutate({ run: () => startCoworkPlanTry(need.itemId), done: t('cowork_home.done.testing', 'Testing once. Nothing is changed or sent.') })}>
                {t('cowork_home.need.try_now', 'Try it now')}
            </button>
        </>
    ) : (
        <button type="button" className={PILL_PRIMARY} onClick={() => onOpenTask(need.itemId, 'steps')}>{t('cowork_home.need.check_steps', 'Check the steps')}</button>
    );
    return <NeedFrame need={need} solo={solo} onOpenTask={onOpenTask} title={title} actions={actions} error={act.error} />;
}

/** Added from a template or a package: it has never been tested, and it starts only after a test. */
export function FirstTestCard({ need, solo, onOpenTask, onDone }: NeedKindProps) {
    const { t } = useTranslation();
    const act = useNeedAct(onDone);
    const actions = (
        <>
            <button type="button" className={PILL_PRIMARY} disabled={act.isPending} onClick={() => act.mutate({ run: () => startCoworkPlanTry(need.itemId), done: t('cowork_home.done.testing', 'Testing once. Nothing is changed or sent.') })}>
                {t('cowork_home.need.test_now', 'Test it now')}
            </button>
            <button type="button" className={PILL_QUIET} disabled={act.isPending} onClick={() => act.mutate({ run: () => deleteCowork(need.itemId), done: t('cowork_home.done.removed', 'Removed.') })}>
                {t('cowork_home.need.remove', 'Remove')}
            </button>
        </>
    );
    return (
        <NeedFrame
            need={need} solo={solo} onOpenTask={onOpenTask} actions={actions} error={act.error}
            title={t('cowork_home.need.first_test', 'Test it once before it starts.')}
            sub={t('cowork_home.need.first_test_sub', 'The test reads real data, but changes and sends nothing.')}
        />
    );
}

type FixMove = 'fix_wiring' | 'check' | 'ai' | 'run' | 'open';

/** Per problem: the sentence, the line under it, the primary action and the way out. */
const FIX: Readonly<Record<NeedProblem, { title: [string, string]; sub: [string, string] | null; primary: FixMove; secondary: FixMove }>> = {
    wiring: {
        title: ['cowork_home.fix.wiring', 'The steps are in the wrong order, so it cannot run.'],
        sub: ['cowork_home.fix.wiring_sub', 'Cowork can fix the order of the steps. What the task may read and send stays the same.'],
        primary: 'fix_wiring', secondary: 'ai',
    },
    blocked: { title: ['cowork_home.fix.blocked', 'The steps cannot run as they are.'], sub: ['cowork_home.fix.choose', 'Check the steps, or let the AI do it each time.'], primary: 'check', secondary: 'ai' },
    tried_failed: { title: ['cowork_home.fix.tried_failed', 'The test of the steps did not pass.'], sub: ['cowork_home.fix.choose', 'Check the steps, or let the AI do it each time.'], primary: 'check', secondary: 'ai' },
    gone: { title: ['cowork_home.fix.gone', 'The steps of this task are gone.'], sub: ['cowork_home.fix.gone_sub', 'The AI can do it each time instead.'], primary: 'ai', secondary: 'open' },
    incomplete: { title: ['cowork_home.fix.incomplete', 'The last run did not do its work: a step found nothing to work on.'], sub: null, primary: 'run', secondary: 'open' },
    ai_failed: { title: ['cowork_home.fix.ai_failed', 'The AI said its last run failed.'], sub: null, primary: 'run', secondary: 'open' },
};

function moveLabel(move: FixMove, t: TranslateFn): string {
    switch (move) {
        case 'fix_wiring': return t('cowork_home.fix.fix_it', 'Fix it for me');
        case 'check': return t('cowork_home.need.check_steps', 'Check the steps');
        case 'ai': return t('cowork_home.fix.ai_each_time', 'Let the AI do it each time');
        case 'run': return t('cowork_home.fix.run_again', 'Run it again');
        default: return t('cowork_home.need.open_task', 'Open the task');
    }
}

/** Something went wrong with the steps or the last run: the fix that resolves it, and the other way. */
export function FixCard({ need, solo, onOpenTask, onDone }: NeedKindProps) {
    const { t } = useTranslation();
    const act = useNeedAct(onDone);
    const fix = FIX[need.problem ?? 'blocked'];
    const id = need.itemId;
    const go = (move: FixMove) => {
        if (move === 'fix_wiring') act.mutate({ run: () => fixCoworkPlanWiring(id), done: t('cowork_home.done.fixed', 'Fixed. Cowork is testing the steps once; nothing is sent.') });
        else if (move === 'ai') act.mutate({ run: () => removeCoworkPlan(id), done: t('cowork_home.done.ai_each_time', 'From now on the AI does it each time.') });
        else if (move === 'run') act.mutate({ run: () => runCoworkNow(id), done: t('cowork_home.done.running', 'Running. The result lands in your notifications.') });
        else onOpenTask(id, move === 'check' ? 'steps' : undefined);
    };
    const actions = (
        <>
            <button type="button" className={PILL_PRIMARY} disabled={act.isPending} onClick={() => go(fix.primary)}>{moveLabel(fix.primary, t)}</button>
            <button type="button" className={PILL_QUIET} disabled={act.isPending} onClick={() => go(fix.secondary)}>{moveLabel(fix.secondary, t)}</button>
        </>
    );
    return <NeedFrame need={need} solo={solo} onOpenTask={onOpenTask} title={t(...fix.title)} sub={fix.sub ? t(...fix.sub) : null} actions={actions} error={act.error} />;
}

/** An app's sign-in ran out and the task paused itself: sign in, then switch it back on. */
export function SignInCard({ need, solo, onOpenTask, onDone }: NeedKindProps) {
    const { t } = useTranslation();
    const act = useNeedAct(onDone);
    const actions = (
        <>
            <a className={PILL_PRIMARY} href={settingsPathForTab('integrations')}>{t('cowork_home.need.sign_in', 'Sign in again')}</a>
            <button type="button" className={PILL_QUIET} disabled={act.isPending} onClick={() => act.mutate({ run: () => toggleCowork(need.itemId), done: t('cowork_home.done.on_again', 'It is on again.') })}>
                {t('cowork_home.need.turn_on', 'Turn it back on')}
            </button>
        </>
    );
    return (
        <NeedFrame
            need={need} solo={solo} onOpenTask={onOpenTask} actions={actions} error={act.error}
            title={t('cowork_home.need.sign_in_title', 'An app needs you to sign in again.')}
            sub={t('cowork_home.need.sign_in_sub', 'The task paused itself, so nothing is lost. Sign in, then turn it back on.')}
        />
    );
}

/** A colleague invited this task to their desk: it joins only when its owner accepts. */
export function InvitationCard({ need, solo, onOpenTask, onDone }: NeedKindProps) {
    const { t } = useTranslation();
    const act = useNeedAct(onDone);
    const desks = useItemDeskActions(need.itemId);
    const desk = need.desk;
    if (!desk) return null;
    const actions = (
        <>
            <button type="button" className={PILL_PRIMARY} disabled={act.isPending} onClick={() => act.mutate({ run: () => desks.accept.mutateAsync(desk.id), done: t('cowork_home.done.joined', 'Accepted. It is on the desk now.') })}>
                {t('cowork_home.need.accept', 'Accept')}
            </button>
            <button type="button" className={PILL_QUIET} disabled={act.isPending} onClick={() => act.mutate({ run: () => desks.leave.mutateAsync(desk.id), done: t('cowork_home.done.declined', 'Declined.') })}>
                {t('cowork_home.need.decline', 'Decline')}
            </button>
        </>
    );
    return (
        <NeedFrame
            need={need} solo={solo} onOpenTask={onOpenTask} actions={actions} error={act.error}
            title={t('cowork_home.need.invitation', '{name} invited this task to the desk “{desk}”', { name: desk.invitedBy, desk: desk.name })}
            sub={t('cowork_home.need.invitation_sub', 'It joins only when you accept, and it keeps running as you.')}
        />
    );
}

/** A colleague's task starts after this one and asks for its result: the owner allows that once. */
export function HandOffCard({ need, solo, onOpenTask, onDone }: NeedKindProps) {
    const { t } = useTranslation();
    const act = useNeedAct(onDone);
    const [later, setLater] = useState(false);
    const handOff = need.handOff;
    const allow = useDeskHandOff(handOff?.deskId ?? '').allow;
    if (!handOff || later) return null;
    const actions = (
        <>
            <button type="button" className={PILL_PRIMARY} disabled={act.isPending} onClick={() => act.mutate({ run: () => allow.mutateAsync(handOff.followerId), done: t('cowork_home.done.allowed', 'Allowed. Each result of this task goes on to it.') })}>
                {t('cowork_home.need.allow', 'Allow')}
            </button>
            <button type="button" className={PILL_QUIET} disabled={act.isPending} onClick={() => setLater(true)}>{t('cowork_home.need.not_now', 'Not now')}</button>
        </>
    );
    return (
        <NeedFrame
            need={need} solo={solo} onOpenTask={onOpenTask} actions={actions} error={act.error}
            title={t('cowork_home.need.hand_off', '{owner}’s task “{task}” asks for the result of this task', { owner: handOff.ownerName, task: handOff.followerTitle })}
            sub={t('cowork_home.need.hand_off_sub', 'It gets each result, never access to your apps. You allow it once.')}
        />
    );
}
