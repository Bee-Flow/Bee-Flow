import { useCoworkMode } from '../coworkDisplayMode';
import { teamworkRequest } from '../coworkTeamworkRequest';
import CoworkOperationReview, { type TaskOperation } from './CoworkOperationReview';
import type { CoworkGlobalDestination } from '@/api/coworkProposals';
import { administersOrg } from '../coworkViewer';
import { beeTransition } from '../beeTransition';
/** An owned Cowork task, with its status and actions above the task's detail tabs. */
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { TaskBack } from '../CoworkPageFrame';
import CoworkPendingPage from '../CoworkPendingPage';
import { useTakePendingQuestion } from '../usePendingBeeDraft';
import { HasTaskOrb } from '../CoworkOrb';
import CoworkNeedCard from '../CoworkNeedCard';
import { BLOCKS, type NeedCardData } from '../coworkNeedsModel';
import { taskStatus } from '../coworkTaskStatus';
import useCoworkNeedCards from '../useCoworkNeedCards';
import type { CoworkSheetPanelProps } from '../coworkSheetPanels';
import CoworkOrbComposer from './CoworkOrbComposer';
import useTaskConversation, { type TaskConversation } from './useTaskConversation';
import CoworkOrbWorkspace from './CoworkOrbWorkspace';
import CoworkTaskOrb, { TaskAnchor, isSetting, type OrbView } from './CoworkTaskOrb';
import { LINK_INLINE } from '../coworkUi';
import CoworkTaskChange from './CoworkTaskChange';
import CoworkTaskHeader, { CoworkTaskActions, type HeldBy } from './CoworkTaskHeader';
import CoworkTaskHistory, { ChangesBody, DeleteTask, ProofBody } from './CoworkTaskHistory';
import CoworkTaskLive, { isLive } from './CoworkTaskLive';
import CoworkTaskOffer from './CoworkTaskOffer';
import CoworkTaskPeople, { type PeopleRowId } from './CoworkTaskPeople';
import CoworkTaskRuns from './CoworkTaskRuns';
import CoworkTaskResult, { AutoFixNote } from './CoworkTaskResult';
import CoworkTaskSettings from './CoworkTaskSettings';
import TaskSetTarget from './TaskSetTarget';
import { MemoryPart, SpendingPart } from './TaskSetKeeps';
import CoworkTaskShared from './CoworkTaskShared';
import CoworkTaskSteps from './CoworkTaskSteps';
import CoworkStepRail from './CoworkStepRail';
import CoworkTaskTabs, { type TaskTab } from './CoworkTaskTabs';
import CoworkTaskTested, { triedResultOf } from './CoworkTaskTested';
import { canTry } from '../coworkPlanModel';
import { inRunOrder, planSteps, latestRunOf, liveRunOf, runFailed, runStatus, taskModeOf } from './coworkTaskModel';
import { Failure, META } from './taskUi';
import { useEntitlements } from '../../licensing/EntitlementsContext';
import { useCoworkItem, useCoworkItemActions } from '@/api/coworkTask';
import type { PlanState } from '@/api/coworkPlan.types';
import { useCoworkPlanQuery, useCoworkPlanTry, useCoworkRunTrace } from '@/api/queries/coworkPlan';
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
    const runHistory = useCoworkRunsQuery(item.id, item.runCount * 2 + (item.lastStatus === 'running' ? 1 : 0));
    const runs = runHistory.data?.runs;
    const maker = useCoworkPlanMaker(item.id);
    const tryOut = useCoworkPlanTry(item.id);
    const items = useMemo(() => [item], [item]);
    const fingerprint = plan?.draft?.fingerprint;
    const all = useCoworkNeedCards(items);
    const cards = useMemo(() => all.filter((c) => c.itemId === item.id).map((c) => (c.kind === 'check' && fingerprint ? { ...c, fingerprint } : c)), [all, item.id, fingerprint]);
    const liveRun = liveRunOf(runs);
    const startingTest = tryOut.start.isPending || (!!tryOut.started && !tryOut.state && !tryOut.error);
    const testing = maker.making.running || startingTest || (!!tryOut.state && !tryOut.state.done);
    const live = startingTest || isLive({ making: maker.making, tryState: tryOut.state, liveRun }) || item.lastStatus === 'running';
    return {
        plan, runHistory, runs: runs ?? [], maker, tryOut, startingTest, cards, liveRun, latest: latestRunOf(runs), live,
        mode: taskModeOf(item, plan),
        blocked: holding(cards).length > 0,
        heldBy: heldByOf(live, cards),
        status: taskStatus(item, cards, { testing }),
    };
}

type Facts = ReturnType<typeof useTaskFacts>;

function RunRead({ facts, t, children }: { facts: Facts; t: TranslateFn; children: ReactNode }) {
    const query = facts.runHistory;
    if (query.data) return <>{children}</>;
    return query.isError ? <div className="flex flex-wrap items-center gap-2">
        <p role="alert">{t('cowork_task.runs.load_failed', 'I couldn’t load the runs for this task.')}</p>
        <button type="button" className={LINK_INLINE} disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{t('cowork_task.retry', 'Try again')}</button>
    </div> : <p role="status" className={META}>{t('cowork_pages.loading', 'Loading…')}</p>;
}

function RunHistory({itemId, facts, onSteps, t}: {itemId: string; facts: Facts; onSteps?: () => void; t: TranslateFn}) {
    return <RunRead facts={facts} t={t}>
        <CoworkTaskRuns coworkId={itemId} runs={facts.runs} total={facts.runHistory.data?.total} onSteps={onSteps} withReceipts heading={t('cowork_task.history.runs', 'Runs')} t={t} />
    </RunRead>;
}

function TopOfTask({ item, facts, onRun, onShare, t }: { item: CoworkItem; facts: Facts; onRun: () => void; onShare: () => void; t: TranslateFn }) {
    const actions = useCoworkItemActions(item.id);
    return (
        <>
            {!facts.live && <CoworkTaskActions item={item} heldBy={facts.heldBy} busy={actions.runNow.isPending || actions.toggle.isPending} t={t}
                onRunNow={() => { actions.runNow.mutate(); onRun(); }} onToggle={() => actions.toggle.mutate()} onShare={onShare} />}
            <Failure error={actions.runNow.error || actions.toggle.error} t={t} />
        </>
    );
}

function CurrentActivity({ item, facts, t }: { item: CoworkItem; facts: Facts; t: TranslateFn }) {
    const [observedRunId, setObservedRunId] = useState<string | null>(null);
    if (facts.liveRun && observedRunId !== facts.liveRun.id) setObservedRunId(facts.liveRun.id);
    const latest = facts.latest;
    const completed = latest && latest.id === observedRunId && runStatus(latest) === 'done' ? latest : null;
    if (!facts.live && (!completed || facts.blocked)) return null;
    return <CoworkTaskLive startingTest={facts.startingTest} coworkId={item.id} making={facts.maker.making} tryState={facts.tryOut.state} liveRun={facts.liveRun ?? completed} runOrder={facts.plan?.draft?.view.runOrder} t={t} />;
}

/** What waits for the owner, what is on the go, or the latest result; and what it could do cheaper. */
function NowOfTask({ item, facts, mayPlan, open, onChange, locale, t }: { item: CoworkItem; facts: Facts; mayPlan: boolean; open: CoworkSheetPanelProps['open']; onChange: () => void; locale: string; t: TranslateFn }) {
    const [done, setDone] = useState<string | null>(null);
    const onOpenTask = (itemId: string, focus?: 'steps' | 'review') => open({ kind: 'task', id: itemId, ...(focus ? { focus } : {}) });
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
            <CurrentActivity item={item} facts={facts} t={t} />
            {quiet && (
                <>
                    <AutoFixNote coworkId={item.id} t={t} />
                    <RunRead facts={facts} t={t}><CoworkTaskResult item={item} latest={facts.latest} locale={locale} t={t} /></RunRead>
                    <CoworkTaskOffer coworkId={item.id} hasSteps={facts.mode === 'steps'} mayPlan={mayPlan} making={facts.maker.making.running} onMakeFromRuns={() => { void facts.maker.start(true); }} t={t} />
                </>
            )}
        </>
    );
}

function guidedSetting(view: OrbView) { return isSetting(view) ? view : 'what'; }

const homeTransfers = {new_task: 'create', attention: 'attention', shared_tasks: 'shared'} as const;
function goHome(next: string): next is keyof typeof homeTransfers {
    return next in homeTransfers;
}

function peopleDestination(next: string): next is PeopleRowId {
    return ['share', 'give', 'pass', 'template'].includes(next);
}

function needsRecovery(next: OrbView, facts: Facts) {
    if (next === 'run') return !!facts.heldBy;
    return next === 'resume' && facts.cards.some(card => card.kind === 'sign_in' && !card.connection?.canResume);
}

function TaskMain({ item, facts, panel, open, close, user, fillComposer }: OwnProps & { facts: Facts }) {
    const { t, locale } = useTranslation();
    const mayPlan = useMayPlan();
    const agents = useCoworkAgents(facts.mode === 'agent');
    const { advanced, setAdvanced, tabId, tab, setTab, view, setView, setting, setSetting, openTab, saved, setSaved } = useTaskNavigation(panel);
    const [people, setPeople] = useState<PeopleRowId | null>(null);
    const [accessTurn, setAccessTurn] = useState({message: '', n: 0});
    const rebuild = () => { void facts.maker.start(false, facts.plan?.automationId ?? undefined); openTab('result'); };
    const conversationView = (next: OrbView | PeopleRowId | CoworkGlobalDestination, message = '', section?: string) => {
        setAdvanced(false);
        if (goHome(next)) return fillComposer(message, homeTransfers[next]);
        if (next === 'teamwork') return open(teamworkRequest(message, item.id, true) ?? {kind: 'teamwork'});
        if (next === 'org') {
            if (administersOrg(user)) open({kind: 'org', section});
            else chat.setReply(t('cowork_panels.org.not_admin', 'Only administrators of your organisation can see and change these rules.'));
            return;
        }
        if (next === 'preferences' || next === 'templates') return open({kind: next === 'preferences' ? 'settings' : next, section});
        if (peopleDestination(next)) {
            setAccessTurn(turn => ({message, n: turn.n + 1}));
            setPeople(next);
            return setView('people');
        }
        if (next === 'people') setPeople(null);
        if (needsRecovery(next, facts)) return setView('overview');
        setView(next);
    };
    const chat = useTaskConversation({ item, plan: facts.plan, view: advanced ? tab : view, live: facts.live,
        select: conversationView, openTask: (id, shared) => open({kind: shared ? 'shared' : 'task', id}), rebuild, t });
    const send = chat.send;
    const takePending = useTakePendingQuestion();
    const dialogPending = chat.dialog.isPending;
    useEffect(() => {
        if (dialogPending || panel.kind !== 'task') return;
        const question = panel.takeQuestion?.() || takePending();
        if (question) send(question, {keepDraft: true});
    }, [panel, send, takePending, dialogPending]);
    const header = <CoworkTaskHeader item={item} status={facts.status} t={t} />;
    const actions = <TopOfTask item={item} facts={facts} onRun={() => openTab('result')} onShare={() => { setPeople('share'); openTab('people'); }} t={t} />;
    const change = <CoworkTaskChange coworkId={item.id} draft={facts.plan?.draft} approved={!!facts.plan?.upToDate}
        live={facts.live} onSetting={row => { setSetting(row); openTab('settings', row); }} t={t} />;
    const panels = {
        result: <NowOfTask item={item} facts={facts} mayPlan={mayPlan} open={open} locale={locale} t={t}
            onChange={() => { setSetting('what'); openTab('settings', 'what'); }} />,
        settings: <CoworkTaskSettings item={item} mode={facts.mode} plan={facts.plan} mayPlan={mayPlan} focused={!advanced} open={advanced ? setting : guidedSetting(view)} onOpen={row => { setSetting(row); if (!advanced && !row) setView('overview'); }} onSaved={() => setSaved(true)} onRecipients={chat.askRecipient}
            onRebuild={rebuild}
            onOpenTask={(id) => open({ kind: 'task', id })} live={facts.live} locale={locale} t={t} />,
        steps: <>
            {advanced && change}
            <div className={facts.live ? undefined : 'peer-open/change:hidden'}>
                <CoworkTaskSteps coworkId={item.id} mode={facts.mode} plan={facts.plan} latestRun={facts.latest} t={t}
                    requested={view === 'test' || view === 'compare' ? view : undefined} live={facts.live} readOnly={false} controlsOnly={!advanced && !!facts.plan?.draft} onRebuild={rebuild} agentName={agents.find((a) => a.id === item.agentId)?.name ?? null}
                    tryOut={{ state: facts.tryOut.state, starting: facts.startingTest, error: facts.tryOut.error, onStart: () => facts.tryOut.start.mutate() }} />
            </div>
        </>,
        people: <CoworkTaskPeople onAccessSaved={() => { setView('overview'); chat.setReply(t('cowork_task.share.saved', 'Access updated.')); }} onTeamwork={(mode, message) => open({kind: 'teamwork', request: {mode, message, itemId: item.id}})} focused={!advanced} key={advanced ? 'advanced' : accessTurn.n} request={accessTurn.message} coworkId={item.id} title={item.title} open={people} onOpen={setPeople} onGone={close} t={t} />,
        history: <CoworkTaskHistory item={item} plan={facts.plan} onGone={close} t={t}>
            <RunHistory itemId={item.id} facts={facts} onSteps={() => openTab('steps')} t={t} />
        </CoworkTaskHistory>,
    };
    if (advanced) return <AdvancedTask heading={header} facts={facts} item={item} chat={chat} onBack={close} onGuided={() => setAdvanced(false)} t={t}>
        {actions}
        <CoworkTaskTabs idPrefix={tabId} value={tab} onChange={setTab} panels={panels} />
    </AdvancedTask>;
    return <GuidedTask onGone={close} back={<TaskBack onBack={close} />} chat={chat} item={item} facts={facts} view={view} saved={saved} setView={setView} onAdvanced={() => beeTransition(() => setAdvanced(true))}
        panels={panels} header={header} actions={<CoworkTaskActions item={item} heldBy={facts.heldBy} expanded busy={chat.busy}
            onRunNow={() => conversationView('run')} onToggle={() => conversationView(item.isActive === false ? 'resume' : 'pause')} onShare={() => conversationView('share')} t={t} />} t={t} />;
}

function AdvancedTask({heading, facts, item, chat, onBack, onGuided, children, t}: {
    heading: ReactNode; facts: Facts; item: CoworkItem; chat: TaskConversation;
    onBack: () => void; onGuided: () => void; children: ReactNode; t: TranslateFn;
}) {
    const draft = facts.plan?.draft;
    const flow = draft ? inRunOrder(draft.view.steps, draft.view.runOrder) : [];
    const activeStep = useActiveStep(item.id, facts);
    const index = flow.findIndex(step => step.id === activeStep);
    const tone = chat.dialog.isPending || chat.busy ? 'thinking' : facts.live ? (flow[index]?.kind === 'ai' ? 'thinking' : 'executing') : 'rest';
    return <div className="cowork-task-guided is-detail flex flex-col gap-4" data-testid="cowork-task-view" data-status={facts.status}>
        <TaskAnchor heading={heading} work={{ flow, apps: item.enabledApps, focus: index < 0 ? undefined : index, action: tone }} tone={tone} />
        <div className="cowork-task-scroll"><HasTaskOrb.Provider value>{children}</HasTaskOrb.Provider></div>
        <CoworkOrbComposer chat={chat} />
        <footer className="cowork-task-footer">
            <TaskBack onBack={onBack} />
            <button className={LINK_INLINE} onClick={onGuided}>{t('cowork_task.orb.back', 'Back to the orb')}</button>
        </footer>
    </div>;
}

function useActiveStep(itemId: string, facts: Facts) {
    const trace = useCoworkRunTrace(itemId, facts.liveRun?.id ?? '').data;
    return facts.tryOut.state?.steps.find(step => step.status === 'running')?.id ?? facts.maker.making.testStep?.id ?? (trace?.recorded ? trace.steps.find(s => s.status === 'running')?.id : undefined);
}

function GuidedResult({ item, facts, onChange, t }: { item: CoworkItem; facts: Facts; onChange: () => void; t: TranslateFn }) {
    const { locale } = useTranslation();
    const [notice, setNotice] = useState('');
    const plan = facts.plan;
    if (!facts.live && !facts.latest && plan && triedResultOf(plan)) {
        const check = facts.cards.find(card => card.kind === 'check');
        return <>{notice && <p role="status">{notice}</p>}<CoworkTaskTested coworkId={item.id} plan={plan} fingerprint={check?.fingerprint ?? null} changed={check?.changed}
            onApproved={setNotice} onChange={onChange} onTest={() => facts.tryOut.start.mutate()} testing={facts.startingTest || !canTry(plan)} t={t} /></>;
    }
    if (facts.latest && runFailed(facts.latest)) return <CoworkTaskRuns
        key={facts.latest.id} coworkId={item.id} runs={[facts.latest]} initialRunId={facts.latest.id} withReceipts
        heading={t('cowork_task.orb.run_details', 'See run details')} t={t} />;
    return <>{notice && <p role="status">{notice}</p>}<CoworkTaskResult item={item} latest={facts.latest} locale={locale} t={t} /></>;
}

function SelectableSteps({plan, chat, t}: {plan: PlanState | undefined; chat: TaskConversation; t: TranslateFn}) {
    if (!plan?.draft) return null;
    return <CoworkStepRail steps={planSteps(plan, t)} selected={chat.selected} toggle={chat.toggle} disabled={chat.dialog.isPending} t={t} />;
}

function GuidedTask({ onGone, back, item, facts, view, saved, setView, onAdvanced, chat, panels, header, actions, t }: {
    onGone: () => void; back: ReactNode; item: CoworkItem; facts: Facts; view: OrbView; saved: boolean; setView: (view: OrbView) => void;
    onAdvanced: () => void; chat: TaskConversation; panels: Record<TaskTab, ReactNode>; header: ReactNode; actions: ReactNode; t: TranslateFn;
}) {
    const active = useActiveStep(item.id, facts);
    const draft = facts.plan?.draft;
    const live = facts.live ? <CurrentActivity item={item} facts={facts} t={t} /> : undefined;
    const workspace = <CoworkOrbWorkspace item={item} plan={facts.plan} chat={chat} select={setView} saved={saved}
        need={facts.cards[0]} latest={facts.latest} live={live}
        active={active} t={t} />;
    const current = view === 'edit' && facts.plan && !draft ? 'what' : view;
    const result = <RunRead facts={facts} t={t}><GuidedResult item={item} facts={facts} onChange={() => setView('edit')} t={t} /></RunRead>;
    const history = <RunHistory itemId={item.id} facts={facts} t={t} />;
    const operation = (name: TaskOperation) => <CoworkOperationReview operation={name} item={item} heldBy={facts.heldBy} t={t} onDone={() => setView('overview')} />;
    const {locale} = useTranslation();
    const views = { ...panels,
        goal: <TaskSetTarget coworkId={item.id} t={t} />,
        memory: <MemoryPart coworkId={item.id} t={t} />,
        budget: <SpendingPart coworkId={item.id} limit={item.monthlyBudget ?? null} locale={locale} t={t} />,
        changes: <ChangesBody coworkId={item.id} plan={facts.plan} t={t} />,
        proof: <ProofBody coworkId={item.id} t={t} />,
        test: panels.steps, compare: panels.steps, run: operation('run'), pause: operation('pause'), resume: operation('resume'), delete: <DeleteTask item={item} onGone={onGone} onCancel={() => setView('overview')} t={t} />, result, history, review: panels.result, overview: workspace, edit: workspace, actions, what: panels.settings, when: panels.settings, uses: panels.settings, sends: panels.settings };
    const detail = current === 'steps' ? <>{!facts.live && <SelectableSteps plan={facts.plan} chat={chat} t={t} />}{views.steps}</> : views[current];
    const showLive = facts.live && ['overview', 'review', 'edit', 'test'].includes(current);
    return <CoworkTaskOrb back={back} status={facts.status} coworkId={item.id} view={current} thinking={chat.busy || chat.dialog.isPending} select={setView} onAdvanced={onAdvanced} live={showLive} saved={saved} composer={<CoworkOrbComposer chat={chat} />}
        heading={header} work={{ flow: draft ? inRunOrder(draft.view.steps, draft.view.runOrder) : [], apps: item.enabledApps, action: isSetting(current) ? 'edit' : 'rest' }} t={t}>
        {showLive ? workspace : detail}
    </CoworkTaskOrb>;
}

function useTaskNavigation(panel: CoworkSheetPanelProps['panel']) {
    const initial = panel.kind === 'task' && panel.focus === 'steps' ? 'steps' : 'result';
    const mode = useCoworkMode();
    const [advanced, setAdvanced] = useState(mode === 'advanced');
    const [tab, setTab] = useState<TaskTab>(initial);
    const [view, choose] = useState<OrbView>(panel.kind === 'task' && panel.focus === 'review' ? 'review' : 'overview');
    const [saved, setSaved] = useState(false);
    const [setting, setSetting] = useState<SettingRowId | null>(null);
    const tabId = useId();
    const setView = (next: OrbView) => beeTransition(() => { setSaved(false); choose(next); });
    const openTab = (next: TaskTab, row: SettingRowId = 'what') => {
        setTab(next);
        setView(next === 'settings' ? row : next === 'steps' ? 'overview' : next);
        if (advanced) document.getElementById(`${tabId}-tab-${next}`)?.focus();
    };
    return { advanced, setAdvanced, tabId, tab, setTab, view, setView, setting, setSetting, openTab, saved, setSaved };
}

function OwnTask(props: OwnProps) {
    const facts = useTaskFacts(props.item);
    return <TaskMain {...props} facts={facts} />;
}

function CoworkTaskView(props: CoworkSheetPanelProps) {
    const { t } = useTranslation();
    const id = props.panel.kind === 'task' ? props.panel.id : '';
    const item = useCoworkItem(id);
    const back = <TaskBack onBack={props.close} />;
    const ask = (message: string) => props.fillComposer(message, 'ask');
    if (item.isPending) return <CoworkPendingPage waitForTask message={t('cowork_task.loading', 'Opening the task…')} ask={ask}>{back}</CoworkPendingPage>;
    // Not the reader's own: a task a colleague shared with them, or one that is gone.
    if (item.data === null) return <CoworkTaskShared {...props} />;
    if (!item.data) return <CoworkPendingPage key="unavailable" message={t('cowork_task.load_failed', 'I couldn’t open this task.')} ask={ask} retry={() => { void item.refetch(); }}>{back}</CoworkPendingPage>;
    return <OwnTask key={id} {...props} item={item.data} />;
}

export default CoworkTaskView;
