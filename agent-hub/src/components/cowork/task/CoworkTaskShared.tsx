/**
 * A task someone else shared with the reader, opened as a page (`kind: 'shared'` of ../coworkSheetPanels.ts): read
 * only. Its status, name, when it runs, "Shared by …" with what the reader may do, its latest result and its earlier runs (server
 * usecases/coworkShares.mts sharedView). No actions: only its owner changes it, and a reader who may answer does so
 * where its questions arrive.
 */
import { useId, useLayoutEffect, useRef, useState } from 'react';
import CoworkOrb from '../CoworkOrb';
import { TaskBack } from '../CoworkPageFrame';
import { errorStatus } from '@/utils/caughtError';
import { LINK_INLINE } from '../coworkUi';
import CoworkTaskHeader from './CoworkTaskHeader';
import CoworkSharedConversation from './CoworkSharedConversation';
import CoworkTaskResult from './CoworkTaskResult';
import CoworkTaskRuns from './CoworkTaskRuns';
import CoworkTaskTabs, { type TaskTab } from './CoworkTaskTabs';
import { latestRunOf } from './coworkTaskModel';
import { whenLine } from '../coworkOverviewModel';
import { taskStatus } from '../coworkTaskStatus';
import type { CoworkSheetPanelProps } from '../coworkSheetPanels';
import { META } from './taskUi';
import { useSharedItem, useSharedWithMe, type SharedView, type ShareRole } from '@/api/coworkShares';
import type { CoworkItem, CoworkRun } from '@/api/cowork.types';
import { useTranslation } from '@/hooks/useTranslation';

/** The shared view as the parts of the sheet read an item and its runs; an answer without its item reads as gone. */
function sharedAsItem(view: SharedView): { item: CoworkItem; runs: CoworkRun[] } | null {
    if (!view?.item) return null;
    const runs: CoworkRun[] = (view.runs ?? []).map((r) => ({ id: r.id, status: r.status ?? '', startedAt: r.startedAt ?? '', result: r.result, durationMs: r.durationMs }));
    const item: CoworkItem = {
        id: view.item.id,
        title: view.item.title,
        prompt: view.item.prompt,
        repeatInterval: view.item.repeatInterval,
        nextRunAt: view.item.nextRunAt,
        lastStatus: view.item.lastStatus,
        isActive: view.item.isActive,
        triggerKind: view.item.triggerKind === 'app_event' ? 'app_event' : 'schedule',
        runCount: runs.length,
        lastRunAt: runs[0]?.startedAt || null,
    };
    return { item, runs };
}

interface SharedContentProps {
    item: CoworkItem;
    runs: CoworkRun[];
    advanced: boolean;
    role: ShareRole;
    owner: string;
    tab: TaskTab;
    setTab: (tab: TaskTab) => void;
}

function SharedContent({item, runs, role, owner, tab, setTab, advanced}: SharedContentProps) {
    const {t, locale} = useTranslation();
    const tabId = useId();
    const panels = {
        result: <CoworkTaskResult item={item} latest={latestRunOf(runs)} locale={locale} t={t} />,
        history: <CoworkTaskRuns coworkId={item.id} runs={runs} withReceipts={false} heading={t('cowork_task.runs.heading', 'Earlier runs')} t={t} />,
    };
    return <>
        <CoworkTaskHeader item={item} status={taskStatus(item)} meta={`${whenLine(item, t)} · ${t('cowork_task.head.sends_owner', 'as {owner} set it up', { owner })}`} sharedBy={{ owner, role }} t={t} />
        {advanced ? <CoworkTaskTabs idPrefix={tabId} value={tab} onChange={setTab} panels={panels} /> : tab === 'history' ? panels.history : panels.result}
    </>;
}

function SharedReadStatus({loading, retry}: { loading: boolean; retry?: () => void }) {
    const {t} = useTranslation();
    if (loading) return <p className={META} role="status">{t('cowork_task.loading', 'Opening the task…')}</p>;
    if (retry) return <>
        <p role="alert" className={META}>{t('cowork_task.load_failed', 'I couldn’t open this task.')}</p>
        <button type="button" className={LINK_INLINE + ' self-start'} onClick={retry}>{t('cowork_task.retry', 'Try again')}</button>
    </>;
    return <p className={META} role="status" data-testid="cowork-task-gone">{t('cowork_task.gone', 'This task is gone, or it is not shared with you.')}</p>;
}

function SharedReadingActions({ advanced, setAdvanced, hasRuns, tab, setTab }: Pick<SharedContentProps, 'advanced' | 'tab' | 'setTab'> & {
    setAdvanced: (value: boolean) => void;
    hasRuns: boolean;
}) {
    const { t } = useTranslation();
    const viewingHistory = tab === 'history';
    return <>
        {!advanced && hasRuns && <button type="button" className={LINK_INLINE} onClick={() => setTab(viewingHistory ? 'result' : 'history')}>
            {viewingHistory ? t('cowork_task.orb.open_result', 'Open result') : t('cowork_task.history.heading', 'History')}
        </button>}
        <button type="button" className={LINK_INLINE} onClick={() => setAdvanced(!advanced)}>
            {advanced ? t('cowork_task.orb.back', 'Back to the orb') : t('cowork_overview.advanced', 'Advanced')}
        </button>
    </>;
}

function SharedWorkspace({ itemId, panel, user, open, close, fillComposer }: CoworkSheetPanelProps & { itemId: string }) {
    const { t } = useTranslation();
    const [tab, setTab] = useState<TaskTab>('result');
    const [advanced, setAdvanced] = useState(false);
    const content = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        if (content.current) content.current.scrollTop = 0;
    }, [tab, advanced]);
    const query = useSharedItem(itemId);
    const owner = (useSharedWithMe().data ?? []).find(s => s.id === itemId)?.ownerName ?? t('cowork_task.shared.someone', 'a colleague');
    const forbidden = [403, 404].includes(errorStatus(query.error) ?? 0);
    const shared = !forbidden && query.data ? sharedAsItem(query.data) : null;
    return <div className="cowork-task-guided cowork-side-shared" data-testid="cowork-task-shared" data-reading={!!shared}>
        <div className="cowork-side-orb"><CoworkOrb tone="rest" /></div>
        <div ref={content} className="cowork-side-content flex flex-col gap-3">
            {shared ? <SharedContent {...shared} advanced={advanced} owner={owner} role={query.data?.role === 'approver' ? 'approver' : 'viewer'} tab={tab} setTab={setTab} />
                : <SharedReadStatus loading={query.isPending} retry={query.isError && !forbidden ? () => void query.refetch() : undefined} />}
        </div>
        <CoworkSharedConversation user={user} itemId={itemId} item={shared?.item} loading={query.isPending}
            takeQuestion={'takeQuestion' in panel ? panel.takeQuestion : undefined} open={open} fillComposer={fillComposer} show={setTab}/>
        <footer className="cowork-task-footer">
            <TaskBack onBack={close} />
            {shared && <SharedReadingActions advanced={advanced} setAdvanced={setAdvanced} hasRuns={shared.runs.length > 0} tab={tab} setTab={setTab} />}
        </footer>
    </div>;
}

export default function CoworkTaskShared(props: CoworkSheetPanelProps) {
    const { panel } = props;
    const itemId = panel.kind === 'shared' || panel.kind === 'task' ? panel.id : '';
    return <SharedWorkspace key={itemId} {...props} itemId={itemId} />;
}
