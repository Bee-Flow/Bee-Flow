/**
 * One task, opened as a page of Cowork (`kind: 'task'` of ../coworkSheetPanels.ts). Self-contained: it reads the task
 * itself (GET /api/cowork/:id), its steps, its runs and what waits for its owner. ONE column of sections, top to
 * bottom, everything about this one task inside it:
 *
 *   1. its status and name; Run for real now, Pause, Share (./CoworkTaskHeader.tsx). A button that is off says why;
 *   2. what waits for its owner, one card each (../CoworkNeedCard.tsx, `solo`): for steps that wait for approval,
 *      what their test produced with Approve and "Change something" on it (./CoworkTaskTested.tsx, in place of the
 *      "check the steps" card); OR what it is doing right now (./CoworkTaskLive.tsx), OR its latest result with the
 *      fix Cowork made by itself (./CoworkTaskResult.tsx); and what it could do cheaper (./CoworkTaskOffer.tsx);
 *   3. Settings: What, When, Uses, Sends to, each with its value, each opened in place (./CoworkTaskSettings.tsx).
 *      There is no edit screen and no "More";
 *   4. its Steps in run order (./CoworkTaskSteps.tsx);
 *   5. People: share, send each result on, save as template, give it away (./CoworkTaskPeople.tsx);
 *   6. History: runs, changes, proof of each run, and Delete at the very bottom (./CoworkTaskHistory.tsx).
 *
 * A task that is not the reader's own is read as one shared with them (./CoworkTaskShared.tsx). Opened at its steps
 * (`focus: 'steps'`), the Steps section is scrolled into view.
 */
import { useEffect, useMemo, useState } from 'react';
import CoworkNeedCard from '../CoworkNeedCard';
import { BLOCKS, type NeedCardData } from '../coworkNeedsModel';
import { taskStatus } from '../coworkTaskStatus';
import useCoworkNeedCards from '../useCoworkNeedCards';
import type { CoworkSheetPanelProps } from '../coworkSheetPanels';
import CoworkTaskHeader, { CoworkTaskActions, type HeldBy } from './CoworkTaskHeader';
import CoworkTaskHistory from './CoworkTaskHistory';
import CoworkTaskLive, { isLive } from './CoworkTaskLive';
import CoworkTaskOffer from './CoworkTaskOffer';
import CoworkTaskPeople, { type PeopleRowId } from './CoworkTaskPeople';
import CoworkTaskResult, { AutoFixNote } from './CoworkTaskResult';
import CoworkTaskSettings from './CoworkTaskSettings';
import CoworkTaskShared from './CoworkTaskShared';
import CoworkTaskSteps from './CoworkTaskSteps';
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

/** Where a button elsewhere on the page can bring the reader: the page's top, and the headings of three sections. */
const PLACES = { top: 'cowork-task-top', settings: 'cowork-task-settings-h', steps: 'cowork-task-steps-h', people: 'cowork-task-people-h' } as const;

/** Bring a place into view; at once for a reader who asked for less motion. */
function showPlace(place: keyof typeof PLACES) {
    const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(PLACES[place])?.scrollIntoView?.({ behavior: still ? 'auto' : 'smooth', block: 'start' });
}

function TopOfTask({ item, facts, onShare, t }: { item: CoworkItem; facts: Facts; onShare: () => void; t: TranslateFn }) {
    const actions = useCoworkItemActions(item.id);
    return (
        <>
            <CoworkTaskHeader item={item} status={facts.status} t={t} />
            <CoworkTaskActions item={item} heldBy={facts.heldBy} busy={actions.runNow.isPending || actions.toggle.isPending} t={t}
                onRunNow={() => actions.runNow.mutate()} onToggle={() => actions.toggle.mutate()} onShare={onShare} />
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

/** Which rows are open, and what a button elsewhere on the page does with them. */
function useOpenRows(atSteps: boolean, hasPlan: boolean) {
    const [setting, setSetting] = useState<SettingRowId | null>(null);
    const [people, setPeople] = useState<PeopleRowId | null>(null);
    useEffect(() => { if (atSteps && hasPlan) showPlace('steps'); }, [atSteps, hasPlan]);
    return {
        setting, setSetting, people, setPeople,
        /** "Change something": What opens, where the sentence is. */
        changeSomething: () => { setSetting('what'); showPlace('settings'); },
        /** "Share": the Share row under People opens. */
        share: () => { setPeople('share'); showPlace('people'); },
    };
}

function TaskMain({ item, facts, panel, open, close }: OwnProps & { facts: Facts }) {
    const { t, locale } = useTranslation();
    const mayPlan = useMayPlan();
    const agents = useCoworkAgents(facts.mode === 'agent');
    const rows = useOpenRows(panel.kind === 'task' && panel.focus === 'steps', !!facts.plan);
    // "Save and test": the steps are made again and tested, and the page shows that at its top.
    const rebuild = () => { void facts.maker.start(); showPlace('top'); };
    return (
        <div id={PLACES.top} className="flex flex-col gap-6 scroll-mt-4" data-testid="cowork-task-view">
            <TopOfTask item={item} facts={facts} onShare={rows.share} t={t} />
            <NowOfTask item={item} facts={facts} mayPlan={mayPlan} open={open} onChange={rows.changeSomething} locale={locale} t={t} />
            <CoworkTaskSettings item={item} mode={facts.mode} plan={facts.plan} mayPlan={mayPlan} open={rows.setting} onOpen={rows.setSetting} onRebuild={rebuild}
                onOpenTask={(id) => open({ kind: 'task', id })} live={facts.live} locale={locale} t={t} />
            <CoworkTaskSteps coworkId={item.id} mode={facts.mode} plan={facts.plan} latestRun={facts.latest} t={t} live={facts.live} readOnly={false}
                agentName={agents.find((a) => a.id === item.agentId)?.name ?? null}
                tryOut={{ state: facts.tryOut.state, starting: facts.tryOut.start.isPending, error: facts.tryOut.error, onStart: () => facts.tryOut.start.mutate() }} />
            <CoworkTaskPeople coworkId={item.id} title={item.title} open={rows.people} onOpen={rows.setPeople} onGone={close} t={t} />
            <CoworkTaskHistory item={item} runs={facts.runs} plan={facts.plan} onGone={close} t={t} />
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
