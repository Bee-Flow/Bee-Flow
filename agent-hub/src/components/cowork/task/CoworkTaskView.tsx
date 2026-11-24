/**
 * One task, opened in the Cowork sheet (`kind: 'task'` of ../coworkSheetPanels.ts). Self-contained: it reads the task
 * itself (GET /api/cowork/:id), its steps, its runs and what waits for its owner. Top to bottom, as the approved
 * redesign has it:
 *
 *   1. its status, name, when · sends to, and goal (./CoworkTaskHeader.tsx); Run now, Pause, Edit;
 *   2. what waits for its owner, one card each (../CoworkNeedCard.tsx, `solo`), OR what it is doing right now
 *      (./CoworkTaskLive.tsx), OR its latest result with the fix Cowork made by itself (./CoworkTaskResult.tsx);
 *   3. what it could do cheaper (./CoworkTaskOffer.tsx);
 *   4. its steps in run order (./CoworkTaskSteps.tsx); "Before it sends something" (./CoworkTaskSending.tsx);
 *   5. earlier runs (./CoworkTaskRuns.tsx), and More, folded (./CoworkTaskMore.tsx).
 *
 * Edit replaces the sheet's content (./CoworkTaskEdit.tsx) and comes back to it. A task that is not the reader's own
 * is read as one shared with them (./CoworkTaskShared.tsx). Opened at its steps (`focus: 'steps'`), the Steps
 * section is scrolled into view.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import CoworkNeedCard from '../CoworkNeedCard';
import { BLOCKS } from '../coworkNeedsModel';
import { taskStatus } from '../coworkTaskStatus';
import useCoworkNeedCards from '../useCoworkNeedCards';
import type { CoworkSheetPanelProps } from '../coworkSheetPanels';
import CoworkTaskEdit from './CoworkTaskEdit';
import CoworkTaskHeader, { CoworkTaskActions, sendsWords } from './CoworkTaskHeader';
import CoworkTaskLive, { isLive } from './CoworkTaskLive';
import CoworkTaskMore from './CoworkTaskMore';
import CoworkTaskOffer from './CoworkTaskOffer';
import CoworkTaskResult, { AutoFixNote } from './CoworkTaskResult';
import CoworkTaskRuns from './CoworkTaskRuns';
import CoworkTaskSending from './CoworkTaskSending';
import CoworkTaskShared from './CoworkTaskShared';
import CoworkTaskSteps from './CoworkTaskSteps';
import { draftOf } from './coworkTaskEditModel';
import { latestRunOf, liveRunOf, taskModeOf } from './coworkTaskModel';
import { BTN_LINK, Failure, META } from './taskUi';
import { useEntitlements } from '../../licensing/EntitlementsContext';
import { useCoworkGoal } from '@/api/coworkGoals';
import { useCoworkStart } from '@/api/coworkStart';
import { useCoworkItem, useCoworkItemActions } from '@/api/coworkTask';
import { useCoworkPlanQuery, useCoworkPlanTry } from '@/api/queries/coworkPlan';
import { useCoworkAgents, useCoworkRunsQuery } from '@/api/queries/coworkReads';
import useCoworkPlanMaker from '@/hooks/useCoworkPlanMaker';
import { useTranslation } from '@/hooks/useTranslation';
import type { CoworkItem } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

type OwnProps = CoworkSheetPanelProps & { item: CoworkItem };

/** Whether the organisation has automations: then a task may get fixed steps. */
function useMayPlan(): boolean {
    const ent = useEntitlements() as { loading: boolean; can?: (id: string) => boolean };
    return !ent.loading && typeof ent.can === 'function' && ent.can('automations');
}

/** Everything the opened task reads, and what follows from it. */
function useTaskFacts(item: CoworkItem) {
    const plan = useCoworkPlanQuery(item.id).data;
    // Read the runs again when a run starts or ends (the task itself is read again while it runs).
    const runs = useCoworkRunsQuery(item.id, item.runCount * 2 + (item.lastStatus === 'running' ? 1 : 0)).data?.runs;
    const maker = useCoworkPlanMaker(item.id);
    const tryOut = useCoworkPlanTry(item.id);
    const items = useMemo(() => [item], [item]);
    const fingerprint = plan?.draft?.fingerprint;
    const all = useCoworkNeedCards(items);
    const cards = useMemo(() => all.filter((c) => c.itemId === item.id).map((c) => (c.kind === 'check' && fingerprint ? { ...c, fingerprint } : c)), [all, item.id, fingerprint]);
    const liveRun = liveRunOf(runs);
    const testing = maker.making.running || (!!tryOut.state && !tryOut.state.done);
    return {
        plan, runs: runs ?? [], maker, tryOut, cards, liveRun, latest: latestRunOf(runs),
        mode: taskModeOf(item, plan),
        live: isLive({ making: maker.making, tryState: tryOut.state, liveRun }) || item.lastStatus === 'running',
        // A hand-off or an invitation asks about another task's work: it does not hold this one back.
        blocked: cards.some((c) => c.kind !== 'hand_off' && c.kind !== 'invitation' && !!BLOCKS[c.kind]),
        status: taskStatus(item, cards, { testing }),
    };
}

type Facts = ReturnType<typeof useTaskFacts>;

/** "After 'Weekly numbers' finishes", opening that task; null for any other start. */
function useAfterLink(item: CoworkItem, open: CoworkSheetPanelProps['open'], t: TranslateFn) {
    const after = useCoworkStart(item.id, true).query.data?.after ?? null;
    if (!after) return null;
    return (
        <button type="button" className="underline underline-offset-2 text-[var(--text-primary)]" onClick={() => open({ kind: 'task', id: after.id })}>
            {t('cowork_task.head.after', "After '{title}' finishes", { title: after.title || t('cowork_task.head.untitled', 'Untitled task') })}
        </button>
    );
}

function TopOfTask({ item, facts, onEdit, open, t }: { item: CoworkItem; facts: Facts; onEdit: () => void; open: CoworkSheetPanelProps['open']; t: TranslateFn }) {
    const goal = useCoworkGoal(item.id).query.data ?? null;
    const actions = useCoworkItemActions(item.id);
    const when = useAfterLink(item, open, t);
    const permissions = facts.plan?.approved?.permissions ?? facts.plan?.draft?.permissions;
    const busy = actions.runNow.isPending || actions.toggle.isPending;
    return (
        <>
            <CoworkTaskHeader item={item} status={facts.status} when={when ?? undefined} goal={goal} t={t}
                sends={sendsWords({ item, mode: facts.mode, sends: permissions?.sends ?? null }, t)} />
            <CoworkTaskActions item={item} live={facts.live} blocked={facts.blocked} busy={busy} t={t}
                onRunNow={() => actions.runNow.mutate()} onToggle={() => actions.toggle.mutate()} onEdit={onEdit} />
            <Failure error={actions.runNow.error || actions.toggle.error} t={t} />
        </>
    );
}

/** What waits for the owner, what is on the go, or the latest result. */
function NowOfTask({ item, facts, open, t }: { item: CoworkItem; facts: Facts; open: CoworkSheetPanelProps['open']; t: TranslateFn }) {
    const [done, setDone] = useState<string | null>(null);
    const onOpenTask = (itemId: string, focus?: 'steps') => open({ kind: 'task', id: itemId, ...(focus ? { focus } : {}) });
    return (
        <>
            {done && <p role="status" className={META} data-testid="cowork-task-done">{done}</p>}
            {facts.cards.map((need) => <CoworkNeedCard key={need.key} need={need} solo onOpenTask={onOpenTask} onDone={setDone} />)}
            {facts.live
                ? <CoworkTaskLive coworkId={item.id} making={facts.maker.making} tryState={facts.tryOut.state} liveRun={facts.liveRun} runOrder={facts.plan?.draft?.view.runOrder} t={t} />
                : !facts.blocked && (
                    <>
                        <AutoFixNote coworkId={item.id} t={t} />
                        <CoworkTaskResult coworkId={item.id} item={item} latest={facts.latest} t={t} />
                    </>
                )}
        </>
    );
}

function TaskMain({ item, facts, onEdit, panel, open, close }: OwnProps & { facts: Facts; onEdit: () => void }) {
    const { t, locale } = useTranslation();
    const mayPlan = useMayPlan();
    const agents = useCoworkAgents(facts.mode === 'agent');
    const steps = useRef<HTMLDivElement>(null);
    const atSteps = panel.kind === 'task' && panel.focus === 'steps';
    const hasPlan = !!facts.plan;
    useEffect(() => { if (atSteps && hasPlan) steps.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' }); }, [atSteps, hasPlan]);
    const approved = facts.mode === 'steps' && !!facts.plan?.approved;
    const sends = facts.plan?.approved?.permissions.sends;
    return (
        <div className="flex flex-col gap-5" data-testid="cowork-task-view">
            <TopOfTask item={item} facts={facts} onEdit={onEdit} open={open} t={t} />
            <NowOfTask item={item} facts={facts} open={open} t={t} />
            {!facts.blocked && !facts.live && (
                <CoworkTaskOffer coworkId={item.id} hasSteps={facts.mode === 'steps'} mayPlan={mayPlan} making={facts.maker.making.running} onMakeFromRuns={() => { void facts.maker.start(true); }} t={t} />
            )}
            <div ref={steps} className="scroll-mt-4">
                <CoworkTaskSteps coworkId={item.id} mode={facts.mode} plan={facts.plan} latestRun={facts.latest} t={t} live={facts.live} readOnly={false}
                    agentName={agents.find((a) => a.id === item.agentId)?.name ?? null}
                    tryOut={{ state: facts.tryOut.state, starting: facts.tryOut.start.isPending, error: facts.tryOut.error, onStart: () => facts.tryOut.start.mutate() }} />
            </div>
            {approved && sends && sends !== 'none' && <CoworkTaskSending coworkId={item.id} t={t} />}
            <CoworkTaskRuns coworkId={item.id} runs={facts.runs} withReceipts t={t} />
            <CoworkTaskMore item={item} hasApprovedSteps={approved} onGone={close} locale={locale} t={t} />
        </div>
    );
}

function EditOfTask({ item, facts, onBack }: { item: CoworkItem; facts: Facts; onBack: () => void }) {
    const { t } = useTranslation();
    const start = useCoworkStart(item.id, true).query;
    const mayPlan = useMayPlan();
    const agents = useCoworkAgents();
    if (start.isPending) return <p className={META} role="status">{t('cowork_task.loading', 'Opening the task…')}</p>;
    return (
        <CoworkTaskEdit itemId={item.id} initial={draftOf(item, start.data, facts.mode)} agents={agents} mayPlan={mayPlan} t={t}
            onRebuild={() => { void facts.maker.start(); }} onBack={onBack} />
    );
}

function OwnTask(props: OwnProps) {
    const facts = useTaskFacts(props.item);
    const [editing, setEditing] = useState(false);
    if (editing) return <EditOfTask item={props.item} facts={facts} onBack={() => setEditing(false)} />;
    return <TaskMain {...props} facts={facts} onEdit={() => setEditing(true)} />;
}

export function CoworkTaskView(props: CoworkSheetPanelProps) {
    const { t } = useTranslation();
    const id = props.panel.kind === 'task' ? props.panel.id : '';
    const item = useCoworkItem(id);
    if (item.isPending) return <p className={META} role="status">{t('cowork_task.loading', 'Opening the task…')}</p>;
    // Not the reader's own: a task a colleague shared with them, or one that is gone.
    if (item.data === null) return <CoworkTaskShared {...props} />;
    if (!item.data) {
        return (
            <div className="flex flex-col gap-2">
                <Failure error={item.error} t={t} />
                <div><button type="button" className={BTN_LINK} onClick={() => { void item.refetch(); }}>{t('cowork_task.retry', 'Try again')}</button></div>
            </div>
        );
    }
    return <OwnTask key={id} {...props} item={item.data} />;
}

export default CoworkTaskView;
