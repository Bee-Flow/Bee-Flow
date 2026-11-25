/** An owned Cowork task, with its status and actions above the task's detail tabs. */
import { useId, useMemo, useState } from 'react';
import CoworkNeedCard from '../CoworkNeedCard';
import { BLOCKS, type NeedCardData } from '../coworkNeedsModel';
import { taskStatus } from '../coworkTaskStatus';
import useCoworkNeedCards from '../useCoworkNeedCards';
import type { CoworkSheetPanelProps } from '../coworkSheetPanels';
import CoworkTaskChange from './CoworkTaskChange';
import CoworkTaskHeader, { CoworkTaskActions, type HeldBy } from './CoworkTaskHeader';
import CoworkTaskHistory from './CoworkTaskHistory';
import CoworkTaskLive, { isLive } from './CoworkTaskLive';
import CoworkTaskOffer from './CoworkTaskOffer';
import CoworkTaskPeople, { type PeopleRowId } from './CoworkTaskPeople';
import CoworkTaskResult, { AutoFixNote } from './CoworkTaskResult';
import CoworkTaskSettings from './CoworkTaskSettings';
import CoworkTaskShared from './CoworkTaskShared';
import CoworkTaskSteps from './CoworkTaskSteps';
import CoworkTaskTabs, { type TaskTab } from './CoworkTaskTabs';
import CoworkTaskTested, { triedResultOf } from './CoworkTaskTested';
import { canTry } from '../coworkPlanModel';
import { latestRunOf, liveRunOf, taskModeOf } from './coworkTaskModel';
import { BTN_LINK, Failure, META } from './taskUi';
import { useEntitlements } from '../../licensing/EntitlementsContext';
import { useCoworkItem, useCoworkItemActions } from '@/api/coworkTask';
import { useCoworkPlanQuery, useCoworkPlanTry } from '@/api/queries/coworkPlan';
import { useCoworkAgents, useCoworkRunsQuery } from '@/api/queries/coworkReads';
import useCoworkPlanMaker from '@/hooks/useCoworkPlanMaker';
import { useTranslation } from '@/hooks/useTranslation';
import type { CoworkItem } from '@/api/cowork.types';
import type { SettingRowId } from './coworkTaskSettingsModel';
import type { TranslateFn } from '@/hooks/useTranslation';

type OwnProps = CoworkSheetPanelProps & { item: CoworkItem };

/** Whether the organisation has automations: then a task may get fixed steps. */
function useMayPlan(): boolean {
    const ent = useEntitlements() as { loading: boolean; can?: (id: string) => boolean };
    return !ent.loading && typeof ent.can === 'function' && ent.can('automations');
}

/** The cards that hold the task back: a hand-off or an invitation asks about another task's work, and does not. */
const holding = (cards: readonly NeedCardData[]): NeedCardData[] => cards.filter((c) => c.kind !== 'hand_off' && c.kind !== 'invitation' && !!BLOCKS[c.kind]);

/** What holds it back from running for real now: something on the go, its steps' approval or first test, or a problem. */
function heldByOf(live: boolean, cards: readonly NeedCardData[]): HeldBy {
    if (live) return 'live';
    const held = holding(cards);
    if (held.length === 0) return null;
    if (held.some((c) => BLOCKS[c.kind] === 'failed')) return 'problem';
    if (held.some((c) => c.kind === 'check')) return 'approval';
    return held.some((c) => c.kind === 'first_test') ? 'test' : 'problem';
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
    const live = isLive({ making: maker.making, tryState: tryOut.state, liveRun }) || item.lastStatus === 'running';
    return {
        plan, runs: runs ?? [], maker, tryOut, cards, liveRun, latest: latestRunOf(runs), live,
        mode: taskModeOf(item, plan),
        blocked: holding(cards).length > 0,
        heldBy: heldByOf(live, cards),
        status: taskStatus(item, cards, { testing }),
    };
}

type Facts = ReturnType<typeof useTaskFacts>;

function TopOfTask({ item, facts, onRun, onShare, t }: { item: CoworkItem; facts: Facts; onRun: () => void; onShare: () => void; t: TranslateFn }) {
    const actions = useCoworkItemActions(item.id);
    return (
        <>
            <CoworkTaskHeader item={item} status={facts.status} t={t} />
            <CoworkTaskActions item={item} heldBy={facts.heldBy} busy={actions.runNow.isPending || actions.toggle.isPending} t={t}
                onRunNow={() => { actions.runNow.mutate(); onRun(); }} onToggle={() => actions.toggle.mutate()} onShare={onShare} />
            <Failure error={actions.runNow.error || actions.toggle.error} t={t} />
        </>
    );
}

/** What waits for the owner, what is on the go, or the latest result; and what it could do cheaper. */
function NowOfTask({ item, facts, mayPlan, open, onChange, locale, t }: { item: CoworkItem; facts: Facts; mayPlan: boolean; open: CoworkSheetPanelProps['open']; onChange: () => void; locale: string; t: TranslateFn }) {
    const [done, setDone] = useState<string | null>(null);
    const onOpenTask = (itemId: string, focus?: 'steps') => open({ kind: 'task', id: itemId, ...(focus ? { focus } : {}) });
    const quiet = !facts.blocked && !facts.live;
    // Steps that wait for approval and whose test left something to show: the owner decides on what they see.
    const check = triedResultOf(facts.plan) ? facts.cards.find((c) => c.kind === 'check' && !!c.fingerprint) : undefined;
    return (
        <>
            {done && <p role="status" className={META} data-testid="cowork-task-done">{done}</p>}
            {facts.cards.filter((need) => need !== check).map((need) => <CoworkNeedCard key={need.key} need={need} solo onOpenTask={onOpenTask} onDone={setDone} />)}
            {facts.plan && !facts.live && (
                <CoworkTaskTested coworkId={item.id} plan={facts.plan} fingerprint={check?.fingerprint ?? null} changed={!!check?.changed} onApproved={setDone} onChange={onChange}
                    onTest={() => facts.tryOut.start.mutate()} testing={facts.tryOut.start.isPending || !canTry(facts.plan)} t={t} />
            )}
            {facts.live && <CoworkTaskLive coworkId={item.id} making={facts.maker.making} tryState={facts.tryOut.state} liveRun={facts.liveRun} runOrder={facts.plan?.draft?.view.runOrder} t={t} />}
            {quiet && (
                <>
                    <AutoFixNote coworkId={item.id} t={t} />
                    <CoworkTaskResult item={item} latest={facts.latest} locale={locale} t={t} />
                    <CoworkTaskOffer coworkId={item.id} hasSteps={facts.mode === 'steps'} mayPlan={mayPlan} making={facts.maker.making.running} onMakeFromRuns={() => { void facts.maker.start(true); }} t={t} />
                </>
            )}
        </>
    );
}

function TaskMain({ item, facts, panel, open, close }: OwnProps & { facts: Facts }) {
    const { t, locale } = useTranslation();
    const mayPlan = useMayPlan();
    const agents = useCoworkAgents(facts.mode === 'agent');
    const tabId = useId();
    const [tab, setTab] = useState<TaskTab>(panel.kind === 'task' && panel.focus === 'steps' ? 'steps' : 'result');
    const [setting, setSetting] = useState<SettingRowId | null>(null);
    const [people, setPeople] = useState<PeopleRowId | null>(null);
    const openTab = (next: TaskTab) => {
        setTab(next);
        document.getElementById(`${tabId}-tab-${next}`)?.focus();
    };

    const rebuild = () => { void facts.maker.start(false, facts.plan?.automationId ?? undefined); openTab('result'); };
    return (
        <div className="flex flex-col gap-6" data-testid="cowork-task-view">
            <TopOfTask item={item} facts={facts} onRun={() => openTab('result')} onShare={() => { setPeople('share'); openTab('people'); }} t={t} />
            <CoworkTaskTabs idPrefix={tabId} value={tab} onChange={setTab} panels={{
                result: <NowOfTask item={item} facts={facts} mayPlan={mayPlan} open={open} locale={locale} t={t}
                    onChange={() => { setSetting('what'); openTab('settings'); }} />,
                settings: <CoworkTaskSettings item={item} mode={facts.mode} plan={facts.plan} mayPlan={mayPlan} open={setting} onOpen={setSetting}
                    onRebuild={rebuild}
                    onOpenTask={(id) => open({ kind: 'task', id })} live={facts.live} locale={locale} t={t} />,
                steps: <><CoworkTaskChange coworkId={item.id} draft={facts.plan?.draft} approved={!!facts.plan?.upToDate} live={facts.live} onSetting={(row) => { setSetting(row); openTab('settings'); }} t={t} /><CoworkTaskSteps coworkId={item.id} mode={facts.mode} plan={facts.plan} latestRun={facts.latest} t={t} live={facts.live} readOnly={false} onRebuild={rebuild}
                    agentName={agents.find((a) => a.id === item.agentId)?.name ?? null}
                    tryOut={{ state: facts.tryOut.state, starting: facts.tryOut.start.isPending, error: facts.tryOut.error, onStart: () => facts.tryOut.start.mutate() }} /></>,
                people: <CoworkTaskPeople coworkId={item.id} title={item.title} open={people} onOpen={setPeople} onGone={close} t={t} />,
                history: <CoworkTaskHistory onSteps={() => openTab('steps')} item={item} runs={facts.runs} plan={facts.plan} onGone={close} t={t} />,
            }} />
        </div>
    );
}

function OwnTask(props: OwnProps) {
    const facts = useTaskFacts(props.item);
    return <TaskMain {...props} facts={facts} />;
}

function CoworkTaskView(props: CoworkSheetPanelProps) {
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
