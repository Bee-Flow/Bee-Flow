/**
 * The cards of ./CoworkNeedCard.tsx about the task's own steps and its place among colleagues: approve the steps, test
 * them once, a sign-in, a desk's invitation and a hand-off. The card of something that went wrong is
 * ./CoworkNeedFix.tsx, the one of a set-up that did not work ./CoworkNeedSetup.tsx, and the cards that carry what a
 * run wrote (a message, a review, a repair) are ./CoworkNeedAsks.tsx. Each is one sentence, one primary action and a
 * way out.
 */
import { useState } from 'react';
import { NeedFrame, useNeedAct, type NeedKindProps } from './CoworkNeedFrame';
import { PILL_PRIMARY, PILL_QUIET } from './coworkUi';
import { settingsPathForTab } from '@/authedApp/settingsRoutes';
import { deleteCowork, toggleCowork } from '@/api/coworkApi';
import { approveCoworkPlan, startCoworkPlanTry } from '@/api/coworkPlanApi';
import { useDeskHandOff, useItemDeskActions } from '@/api/coworkDesks';
import { apiJson } from '@/api/typedRequest';
import { useTranslation } from '@/hooks/useTranslation';

/** The steps are ready: on the home, open the task to approve them; inside it, approve them or test them once more. */
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
                {t('cowork_home.need.approve', 'Approve')}
            </button>
            <button type="button" className={PILL_QUIET} disabled={act.isPending} onClick={() => act.mutate({ run: () => startCoworkPlanTry(need.itemId), done: t('cowork_home.done.testing', 'Testing once. Nothing is changed or sent.') })}>
                {t('cowork_home.need.test', 'Test, sends nothing')}
            </button>
        </>
    ) : (
        <button type="button" className={PILL_PRIMARY} onClick={() => onOpenTask(need.itemId, 'steps')}>{t('cowork_home.need.open_approve', 'Open and approve')}</button>
    );
    return (
        <NeedFrame
            need={need} solo={solo} onOpenTask={onOpenTask} title={title} actions={actions} error={act.error}
            sub={need.held ? t('cowork_home.need.check_sub', 'It does not run for real until you approve them.') : null}
        />
    );
}

/** Added from a template or a package: it has never been tested, and it starts only after a test. */
export function FirstTestCard({ need, solo, onOpenTask, onDone }: NeedKindProps) {
    const { t } = useTranslation();
    const act = useNeedAct(onDone);
    const [removing, setRemoving] = useState(false);
    const actions = removing ? (
        <>
            <button type="button" className={PILL_PRIMARY} disabled={act.isPending} onClick={() => act.mutate({ run: () => deleteCowork(need.itemId), done: t('cowork_home.done.removed', 'Removed.') })}>
                {t('cowork_home.need.remove_task', 'Remove the task')}
            </button>
            <button type="button" className={PILL_QUIET} disabled={act.isPending} onClick={() => setRemoving(false)}>{t('cowork_home.need.keep', 'Keep it')}</button>
        </>
    ) : (
        <>
            <button type="button" className={PILL_PRIMARY} disabled={act.isPending} onClick={() => act.mutate({ run: () => startCoworkPlanTry(need.itemId), done: t('cowork_home.done.testing', 'Testing once. Nothing is changed or sent.') })}>
                {t('cowork_home.need.test', 'Test, sends nothing')}
            </button>
            <button type="button" className={PILL_QUIET} disabled={act.isPending} onClick={() => setRemoving(true)}>{t('cowork_home.need.remove', 'Remove')}</button>
        </>
    );
    return (
        <NeedFrame
            need={need} solo={solo} onOpenTask={onOpenTask} actions={actions} error={act.error}
            title={removing ? t('cowork_home.need.remove_sure', 'Remove this task? This cannot be undone.') : t('cowork_home.need.first_test', 'Test it once before it starts.')}
            sub={removing ? null : t('cowork_home.need.first_test_sub', 'The test reads real data, but changes and sends nothing.')}
        />
    );
}

/** An app's sign-in ran out and the task paused itself: sign in, then switch it back on. */
/**
 * Switch a paused task on. Signing in again already resumes the tasks that paused for it, and the switch is a flip:
 * a task that is on by now is left on, not paused again.
 */
async function turnOn(itemId: string): Promise<void> {
    const item = await apiJson<'GET /api/cowork/{id}', { isActive?: boolean }>('GET /api/cowork/{id}', { params: { id: itemId } });
    if (item.isActive !== true) await toggleCowork(itemId);
}

export function SignInCard({ need, solo, onOpenTask, onDone }: NeedKindProps) {
    const { t } = useTranslation();
    const act = useNeedAct(onDone);
    const actions = (
        <>
            <a className={PILL_PRIMARY} href={settingsPathForTab('integrations')}>{t('cowork_home.need.sign_in', 'Sign in again')}</a>
            <button type="button" className={PILL_QUIET} disabled={act.isPending} onClick={() => act.mutate({ run: () => turnOn(need.itemId), done: t('cowork_home.done.on_again', 'It is on again.') })}>
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
    if (!handOff) return null;
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
            need={need} solo={solo} onOpenTask={onOpenTask} actions={actions} error={act.error} open={!later}
            title={t('cowork_home.need.hand_off', '{owner}’s task “{task}” asks for the result of this task', { owner: handOff.ownerName, task: handOff.followerTitle })}
            sub={t('cowork_home.need.hand_off_sub', 'It gets each result, never access to your apps. You allow it once.')}
        />
    );
}
