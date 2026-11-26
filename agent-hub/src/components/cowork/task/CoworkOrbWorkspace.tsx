import { useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, FileText } from 'lucide-react';
import { useNeedAct } from '../CoworkNeedFrame';
import { fixCoworkPlanWiring } from '@/api/coworkPlanApi';
import { Failure } from './taskUi';
import { settingsPathForTab } from '@/authedApp/settingsRoutes';
import type { CoworkItem, CoworkRun } from '@/api/cowork.types';
import type { PlanState } from '@/api/coworkPlan.types';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { NeedCardData } from '../coworkNeedsModel';
import { orbInsight, type OrbInsight } from './orbInsight';
import CoworkActivity from '../CoworkActivity';
import type { OrbWork } from '../CoworkOrbSources';
import CoworkProposalDetails from '../CoworkProposalDetails';
import { BUTTON_PRIMARY, LINK_INLINE } from '../coworkUi';
import CoworkStepRail from './CoworkStepRail';
import { inRunOrder, planSteps } from './coworkTaskModel';
import type { OrbView } from './CoworkTaskOrb';
import type { TaskConversation } from './useTaskConversation';

interface Props {
    item: CoworkItem; plan?: PlanState; select: (v: OrbView) => void; chat: TaskConversation;
    saved: boolean; need?: NeedCardData; latest: CoworkRun | null; live?: ReactNode; active?: string; t: TranslateFn;
}

function feedback(s: TaskConversation, t: TranslateFn) {
    if (s.dialog.isPending) return t('cowork_task.orb.thinking', 'I’m looking into that.');
    if (s.edit.requestChange.isPending) return t('cowork_home.activity.proposal', 'Preparing and testing your change…');
    if (s.edit.approve.isPending) return t('cowork_home.activity.applying', 'Applying your change…');
    if (s.edit.dismiss.isPending) return t('cowork_home.activity.discarding', 'Discarding the proposal…');
    if (s.proposal) return t('cowork_task.orb.review', 'Apply this tested change?');
    if (s.edit.approve.isSuccess) return t('cowork_home.activity.applied', 'Your change has been applied.');
    if (s.edit.dismiss.isSuccess) return t('cowork_home.activity.discarded', 'Proposal discarded.');
    return null;
}

function Review({ state: s, t }: { state: TaskConversation; t: TranslateFn }) {
    const p = s.proposal;
    if (!p) return null;
    return <div className="cowork-review">
        <h2 className="text-lg font-semibold">{t('cowork_task.orb.review', 'Apply this tested change?')}</h2>
        <CoworkProposalDetails proposal={p} t={t} compact />
        {!!p.recipients?.length && <p>{t('cowork_task.set.sends', 'Sends to')} · {p.recipients.join(', ')}</p>}
        <div className="flex flex-wrap gap-2">
            <button className={BUTTON_PRIMARY} onClick={() => s.edit.approve.mutate({ proposalId: p.id, fingerprint: p.fingerprint })}>{t('cowork_task.tested.approve', 'Approve')}</button>
            <button className={LINK_INLINE} onClick={() => s.edit.dismiss.mutate(p.id)}>{t('cowork_task.edit.discard', 'Discard proposal')}</button>
        </div>
    </div>;
}


function hasDestinations(chat: TaskConversation) {
    return chat.destinations.choices.length > 0 || chat.destinations.tasks.length > 0;
}

function Destinations({ chat, t }: Pick<Props, 'chat' | 't'>) {
    if (chat.destinations.choices.length) {
        const labels = {
            when: t('cowork_task.orb.schedule', 'Schedule'), what: t('cowork_home.activity.edit_brief', 'Edit task instructions'),
            uses: t('cowork_task.orb.apps_model', 'Apps and model'), sends: t('cowork_task.set.sends', 'Sends to'),
        };
        return <nav className="cowork-orb-choices" aria-label={t('cowork_task.set.heading', 'Settings')}>
            {chat.destinations.choices.map(key => <button key={key} onClick={() => chat.destinations.pickChoice(key)}>{labels[key]}<ChevronRight size={15} aria-hidden="true" /></button>)}
        </nav>;
    }
    return <nav className="cowork-orb-choices" aria-label={t('cowork_pages.back', 'Tasks')}>
        {chat.destinations.tasks.map(task => <button key={task.id} onClick={() => chat.destinations.openTask(task.id, task.shared)}>
            <span>{task.title}<small className="block text-[var(--text-secondary)]">{task.detail}</small></span><ChevronRight size={15} aria-hidden="true" />
        </button>)}
    </nav>;
}

function RecoveryAction({ need, chat, t, primary, select, item }: Pick<Props, 'need' | 'chat' | 't' | 'select' | 'item'> & Pick<OrbInsight, 'primary'>) {
    const repair = useNeedAct(chat.setReply);
    if (need?.connection?.canResume) return <button className={BUTTON_PRIMARY} onClick={chat.resume}>{t('cowork_task.action.resume', 'Resume')}</button>;
    if (need?.kind === 'sign_in' || need?.problem === 'signed_out') return <a className={BUTTON_PRIMARY}
        href={settingsPathForTab('integrations')}>{t('cowork_home.need.sign_in', 'Sign in again')}</a>;
    if (need?.problem === 'wiring') return <>
        <button className={BUTTON_PRIMARY} disabled={repair.isPending} onClick={() => repair.mutate({run: () => fixCoworkPlanWiring(item.id),
            done: t('cowork_home.done.fixed', 'Fixed. Cowork is testing the steps once; nothing is sent.')})}>{t('cowork_home.fix.fix_it', 'Fix it for me')}</button>
        <Failure error={repair.error} t={t} />
    </>;
    return primary && <button className={BUTTON_PRIMARY} onClick={() => select(primary.view)}>{primary.label}</button>;
}

function Controls({ item, chat, need, insight: { primary, hasResult }, select, plan, t }: Props & { insight: OrbInsight }) {
    if (chat.busy) return null;
    if (chat.pendingBrief) return <div className="flex gap-2">
        <button className={BUTTON_PRIMARY} onClick={chat.saveBrief}>{plan?.draft ? t('cowork_task.edit.save_test', 'Save and test') : t('cowork_task.edit.save', 'Save')}</button>
        <button className={LINK_INLINE} onClick={chat.cancel}>{t('cowork_task.edit.cancel', 'Cancel')}</button>
    </div>;
    if (hasDestinations(chat)) return <Destinations chat={chat} t={t} />;
    if (!primary && !hasResult) return null;
    return <div className="flex flex-wrap items-center gap-2">
        <RecoveryAction need={need} primary={primary} select={select} chat={chat} t={t} item={item} />
        {hasResult && primary?.view !== 'result' && <button className={LINK_INLINE} onClick={() => select('result')}><FileText size={15}/>{t('cowork_task.orb.open_result', 'Open result')}</button>}
    </div>;
}

function caption(props: Props, insight: OrbInsight) {
    const {chat, saved, t} = props;
    const status = feedback(chat, t);
    if (status) return status;
    if (chat.selected.length) return t('cowork_task.orb.selected', '{count} steps selected', { count: chat.selected.length });
    if (saved) return t('cowork_task.edit.saved', 'Saved');
    return insight.message;
}

function orbWork({ item, plan, chat }: Props, thinking: boolean): OrbWork {
    const draft = plan?.draft;
    const flow = draft ? inRunOrder(draft.view.steps, draft.view.runOrder) : [];
    const focus = flow.findIndex(step => step.id === chat.selected.at(-1));
    return { flow, apps: item.enabledApps, focus: focus < 0 ? undefined : focus, action: thinking ? 'thinking' : 'rest' };
}

function sidebarContent({chat, live}: Props, insight: OrbInsight, review: boolean, count: number) {
    const choosing = hasDestinations(chat) || !!chat.pendingBrief;
    const showControls = !live && !review && !chat.busy && !chat.dialog.isPending && !!(choosing || insight.primary || insight.hasResult);
    return {showControls, showSteps: count > 0 && !choosing};
}

function StepList({rows, review, active, chat, t}: Props & {rows: ReturnType<typeof planSteps>; review: boolean}) {
    const [expanded, setExpanded] = useState(false);
    const railId = useId();
    return <>
                {review && <button className="cowork-step-disclosure" aria-expanded={expanded} aria-controls={railId} onClick={() => setExpanded(!expanded)}>
                    {chat.selected.length ? t('cowork_task.orb.selected', '{count} steps selected', {count: chat.selected.length}) : t('cowork_task.steps.heading', 'Steps')}
                    <ChevronDown size={15} aria-hidden="true" />
                </button>}
                <div id={railId}><CoworkStepRail steps={rows} selected={chat.selected} toggle={chat.toggle} disabled={chat.dialog.isPending} active={active} t={t} /></div>
    </>;
}

export default function CoworkOrbWorkspace(props: Props) {
    const { plan, live, chat, t } = props;
    const choosing = hasDestinations(chat);
    const rows = plan ? planSteps(plan, t) : [];
    const thinking = chat.busy || chat.dialog.isPending;
    const review = !!chat.proposal && !live && !chat.busy;
    const insight = orbInsight(props);
    const work = orbWork(props, thinking);
    const {showSteps, showControls} = sidebarContent(props, insight, review, rows.length);
    const sidebar = showControls || showSteps;
    return <>
        <div data-choosing={choosing || undefined} className={'cowork-orb-workspace' + (sidebar ? ' has-steps' : '') + (review ? ' is-review' : '')}>
            <div className="min-w-0">{live || <CoworkActivity captionAbove message={caption(props, insight)} tone={thinking ? 'thinking' : 'rest'} work={work} />}</div>
            {sidebar && <div className="cowork-workspace-steps flex flex-col gap-4">
                {showControls && <Controls {...props} insight={insight} />}
                {showSteps && <StepList {...props} rows={rows} review={review} />}
            </div>}
        </div>
        {review && <Review state={chat} t={t} />}
    </>;
}
