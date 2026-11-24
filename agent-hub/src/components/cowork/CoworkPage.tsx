/**
 * /app/cowork: what the owner handed to Bee Flow, as one calm column (./CoworkHome.tsx), and a sheet from the right
 * for whatever is opened from it (./CoworkSheet.tsx): a task, or from the header's menu Settings, Teamwork,
 * Templates and, for an administrator, Organisation. What each kind shows is ./coworkSheetPanels.ts.
 *
 * Deep-linkable at /app/cowork/:id: the task opens in the sheet. Opening a task says so in the address, closing it
 * goes back to /app/cowork.
 */
import { Suspense, useCallback, useState } from 'react';
import CoworkHome from './CoworkHome';
import CoworkSheet from './CoworkSheet';
import CoworkUserMenu from './CoworkUserMenu';
import type { TaskFocus } from './CoworkNeedFrame';
import { COWORK_SHEET_PANELS, type CoworkSheetPanel } from './coworkSheetPanels';
import useCoworkList from './useCoworkList';
import { useTranslation } from '@/hooks/useTranslation';
import type { CoworkPageProps } from '@/api/cowork.types';

/** The sheet's name for a screen reader: a task's title, else the kind's own name. */
function useSheetLabel(panel: CoworkSheetPanel | null): string {
    const { t } = useTranslation();
    const items = useCoworkList().data?.items;
    if (!panel) return '';
    const title = panel.kind === 'task' ? items?.find((i) => i.id === panel.id)?.title : null;
    const [key, en] = COWORK_SHEET_PANELS[panel.kind].label;
    return title || t(key, en);
}

export default function CoworkPage({ user = null, initialCoworkId = null, onNavigate }: CoworkPageProps) {
    const { t } = useTranslation();
    const [panel, setPanel] = useState<CoworkSheetPanel | null>(initialCoworkId ? { kind: 'task', id: initialCoworkId } : null);
    const [seed, setSeed] = useState<{ text: string; n: number } | null>(null);
    const label = useSheetLabel(panel);

    // A deep link wins on arrival, and again when it changes; in between the owner's clicks decide.
    const [linked, setLinked] = useState(initialCoworkId);
    if (initialCoworkId !== linked) {
        setLinked(initialCoworkId);
        if (initialCoworkId) setPanel({ kind: 'task', id: initialCoworkId });
    }

    const onTask = panel?.kind === 'task';
    const open = useCallback((next: CoworkSheetPanel) => {
        setPanel(next);
        if (next.kind === 'task') onNavigate?.(`cowork/${next.id}`);
        else if (onTask) onNavigate?.('cowork');
    }, [onNavigate, onTask]);
    const openTask = useCallback((id: string, focus?: TaskFocus) => open({ kind: 'task', id, ...(focus ? { focus } : {}) }), [open]);
    const close = useCallback(() => {
        if (onTask) onNavigate?.('cowork');
        setPanel(null);
    }, [onTask, onNavigate]);
    const fillComposer = useCallback((text: string) => {
        setSeed((was) => ({ text, n: (was?.n ?? 0) + 1 }));
        close();
    }, [close]);

    const Panel = panel ? COWORK_SHEET_PANELS[panel.kind].component : null;
    return (
        <div className="flex-1 min-h-0 min-w-0 overflow-y-auto custom-scrollbar bg-[var(--bg-primary)]" data-testid="cowork-page">
            <div className="max-w-[720px] mx-auto px-4 pt-5 pb-24 flex flex-col gap-7">
                <header className="flex items-center gap-3">
                    <span className="mr-auto text-[20px] font-semibold text-[var(--text-primary)]">{t('sidebar.cowork', 'Cowork')}</span>
                    <CoworkUserMenu user={user} onOpen={(kind) => open({ kind })} />
                </header>
                <CoworkHome onOpenTask={openTask} onOpenPanel={open} seed={seed} />
            </div>
            <CoworkSheet open={!!panel} label={label} onClose={close}>
                {panel && Panel && (
                    <Suspense fallback={<p className="text-[14px] text-[var(--text-tertiary)]">{t('cowork_home.loading', 'Loading…')}</p>}>
                        <Panel key={panel.kind === 'task' || panel.kind === 'shared' ? `${panel.kind}-${panel.id}` : panel.kind} panel={panel} user={user} close={close} open={open} fillComposer={fillComposer} />
                    </Suspense>
                )}
            </CoworkSheet>
        </div>
    );
}
