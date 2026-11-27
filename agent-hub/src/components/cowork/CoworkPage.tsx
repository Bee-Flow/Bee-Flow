/**
 * /app/cowork: what the owner handed to Bee Flow, as one calm column. The home (./CoworkHome.tsx) lists it; a task,
 * Cowork preferences, Teamwork, Templates and Admin rules each open as a full PAGE in the same column, in place of the
 * home and under a "Tasks" link back to it (./CoworkPageFrame.tsx). Nothing lies over the page: no sheet, no scrim.
 * What each page shows is ./coworkSheetPanels.ts.
 *
 * A page has an address (`/app/cowork/<id>` for a task, `/app/cowork/preferences`, …), so the browser's Back returns
 * to the home and a page can be linked to. The address decides on arrival and whenever it changes; a click sets the
 * page and the address together. The home stays mounted while a page is open (a sentence being written, a set-up in
 * progress and the place in the list are kept); on the way back the focus returns to what opened the page. The home
 * and a page arrive the same way (ENTER of ./coworkMotion.ts).
 */
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { Settings } from 'lucide-react';
import { beeTransition } from './beeTransition';
import CoworkIntroduction from './CoworkIntroduction';
import { DisplayMode, rememberMode, savedMode, useCoworkMode, type CoworkMode } from './coworkDisplayMode';
import CoworkHome from './CoworkHome';
import { GuidedPanelContext, PanelFocusContext } from './panels/panelGuidance';
import CoworkPageFrame from './CoworkPageFrame';
import CoworkPendingPage from './CoworkPendingPage';
import './coworkViewport.css';
import type { TaskFocus } from './CoworkNeedFrame';
import { ENTER } from './coworkMotion';
import { COWORK_SHEET_PANELS, pageName, pageOfSegment, pageSegment, samePage, type ComposerSeed, type CoworkSheetPanel, type HomeTransfer } from './coworkSheetPanels';
import { ICON_BUTTON, LINK_INLINE } from './coworkUi';
import { administersOrg } from './coworkViewer';
import useCoworkList from './useCoworkList';
import { useTranslation } from '@/hooks/useTranslation';
import type { CoworkPageProps } from '@/api/cowork.types';

/** The page's name for a screen reader: a task's title, else the kind's own name. */
function usePageLabel(page: CoworkSheetPanel | null): string {
    const { t } = useTranslation();
    const items = useCoworkList().data?.items;
    if (!page) return '';
    const title = page.kind === 'task' ? items?.find((i) => i.id === page.id)?.title : null;
    return title || pageName(page.kind, t);
}

/** The page shown, following the address: it decides on arrival and whenever it changes (Back, Forward, a link). */
function usePageOfAddress(segment: string | null): [CoworkSheetPanel | null, (next: CoworkSheetPanel | null) => void] {
    const [page, setPage] = useState<CoworkSheetPanel | null>(() => pageOfSegment(segment));
    const [linked, setLinked] = useState(segment);
    if (segment !== linked) {
        setLinked(segment);
        const next = pageOfSegment(segment);
        // The page a click just opened keeps what the click said (a task opened at its steps).
        if (!samePage(next, page)) setPage(next);
    }
    return [page, setPage];
}

/**
 * Where the reader was on the home, kept while a page is open: what opened the page gets the focus back, and the
 * column scrolls back to where it stood. What opened it is the control last pressed on the home (`pressed`, since not
 * every browser focuses a button on a click), else what has the focus; `fallback` takes the focus when nothing on the
 * home opened the page (a link).
 */
function useHomePlace(pageKey: string | null) {
    const open = pageKey !== null;
    const scroller = useRef<HTMLDivElement>(null);
    const fallback = useRef<HTMLParagraphElement>(null);
    const place = useRef<{ opener: HTMLElement | null; top: number } | null>(null);
    const lastPressed = useRef<HTMLElement | null>(null);
    const pressed = useCallback((e: MouseEvent<HTMLElement>) => {
        lastPressed.current = e.target instanceof Element ? e.target.closest<HTMLElement>('button, a[href]') : null;
    }, []);
    const remember = useCallback(() => {
        if (place.current) return;
        const active = document.activeElement;
        const focused = active instanceof HTMLElement && active !== document.body ? active : null;
        place.current = { opener: lastPressed.current ?? focused, top: scroller.current?.querySelector('.cowork-home-context')?.scrollTop ?? 0 };
    }, []);
    // Before the paint: a page starts at its top, and the home comes back where it was left.
    useLayoutEffect(() => {
        const column = scroller.current;
        if (open) return;
        const was = place.current;
        if (!was) return;
        place.current = null;
        const context = column?.querySelector('.cowork-home-context');
        if (context) context.scrollTop = was.top;
        const target = was.opener?.isConnected ? was.opener : fallback.current ?? column?.querySelector<HTMLElement>('#cowork-brief');
        target?.focus({ preventScroll: true });
    }, [open, pageKey]);
    // A page the address opened (a link, Forward) is left the same way: to the home's own heading.
    useEffect(() => {
        if (open && !place.current) place.current = { opener: null, top: 0 };
    }, [open]);
    return { scroller, fallback, remember, pressed };
}

function homePlacement(page: CoworkSheetPanel | null) {
    const teamTurn = page?.kind === 'teamwork' ? page.request : undefined;
    const embedded = !!page && ['settings', 'templates', 'org', 'teamwork'].includes(page.kind);
    const hidden = !!page && !embedded;
    const context = teamTurn ? 'teamwork: ' + teamTurn.message : page?.kind;
    return {embedded, hidden, context, focus: page && 'section' in page ? page.section : undefined,
        className: hidden ? 'hidden' : `${ENTER} cowork-home-frame`};
}

function inheritTeamTask(next: CoworkSheetPanel, current: CoworkSheetPanel | null) {
    if (next.kind !== 'teamwork' || !next.request || current?.kind !== 'teamwork') return next;
    return {...next, request: {...next.request, itemId: next.request.itemId ?? current.request?.itemId}};
}

export default function CoworkPage(props: CoworkPageProps) {
    const key = props.user?.id ? 'cowork.2.view.' + props.user.id : '';
    return <CoworkEntry key={key} storageKey={key} {...props} />;
}

function CoworkEntry({storageKey, ...props}: CoworkPageProps & {storageKey: string}) {
    const [mode, setMode] = useState(() => storageKey ? savedMode(storageKey) : 'orb');
    function choose(value: CoworkMode) {
        rememberMode(storageKey, value);
        setMode(value);
    }
    if (!mode) return <CoworkIntroduction choose={choose} />;
    return <DisplayMode.Provider value={mode}><CoworkWorkspace {...props} chooseView={() => setMode(null)} /></DisplayMode.Provider>;
}

function CoworkWorkspace({ user = null, initialCoworkId = null, onNavigate, chooseView }: CoworkPageProps & {chooseView: () => void}) {
    const { t } = useTranslation();
    const [page, setPage] = usePageOfAddress(initialCoworkId);
    const [seed, setSeed] = useState<ComposerSeed | null>(null);
    const mode = useCoworkMode();
    const [dashboard, setDashboard] = useState(mode === 'advanced');
    const label = usePageLabel(page);
    const { scroller, fallback, remember, pressed } = useHomePlace(page ? pageSegment(page) : null);

    const open = useCallback((next: CoworkSheetPanel) => {
        remember();
        beeTransition(() => {
            if (next.kind === 'teamwork' && next.request) setDashboard(false);
            setPage(inheritTeamTask(next, page));
            onNavigate?.(`cowork/${pageSegment(next)}`);
        });
    }, [onNavigate, page, remember, setPage]);
    const askTask = (id: string, message: string, shared = false) => {
        let pending = message;
        open({ kind: shared ? 'shared' : 'task', id, takeQuestion: () => {
            const question = pending;
            pending = '';
            return question;
        } });
    };
    const openTask = useCallback((id: string, focus?: TaskFocus) => open({ kind: 'task', id, ...(focus ? { focus } : {}) }), [open]);
    const close = useCallback(() => {
        beeTransition(() => {
            setPage(null);
            onNavigate?.('cowork');
        });
    }, [onNavigate, setPage]);
    const fillComposer = useCallback((text: string, action?: HomeTransfer) => {
        let pending = action;
        if (action) setDashboard(false);
        setSeed(was => ({text, n: (was?.n ?? 0) + 1, takeAction: () => {
            const next = pending;
            pending = undefined;
            return next;
        }}));
        close();
    }, [close]);

    useEffect(() => {
        if (!page && document.activeElement === document.body) scroller.current?.querySelector<HTMLTextAreaElement>('#cowork-brief')?.focus({preventScroll: true});
    }, [page, scroller]);
    const Page = page ? COWORK_SHEET_PANELS[page.kind].component : null;
    const placement = homePlacement(page);
    return (
        <div ref={scroller} className="cowork-viewport flex-1 min-h-0 min-w-0 bg-[var(--bg-primary)] text-[14px] leading-5 text-[var(--text-primary)]" data-testid="cowork-page">
            <div className={page ? 'cowork-open-page' : 'cowork-guided-home'} data-dashboard={dashboard}>
                {page && Page && (
                    <CoworkPageFrame key={pageSegment(page)} label={label} onBack={close} ownBack={page.kind === 'task' || page.kind === 'shared'}>
                        <Suspense fallback={<CoworkPendingPage waitForTask message={t('cowork_pages.loading', 'Loading…')} ask={placement.embedded ? undefined : text => fillComposer(text, 'ask')} />}>
                            <GuidedPanelContext.Provider value={!dashboard}><PanelFocusContext.Provider value={placement.focus}><Page panel={page} user={user} close={close} open={open} fillComposer={fillComposer} /></PanelFocusContext.Provider></GuidedPanelContext.Provider>
                        </Suspense>
                    </CoworkPageFrame>
                )}
                <div data-bee-embedded={placement.embedded} hidden={placement.hidden} className={placement.className} onClickCapture={pressed}>
                    {dashboard && <header hidden={placement.embedded} className="flex items-center gap-2">
                        <p ref={fallback} tabIndex={-1} className="m-0 mr-auto text-[20px] leading-7 font-semibold text-[var(--text-primary)] outline-none">{t('sidebar.cowork', 'Cowork')}</p>
                        {administersOrg(user) && (
                            <button type="button" className={LINK_INLINE} onClick={() => open({ kind: 'org' })} data-testid="cowork-admin-rules">
                                {pageName('org', t)}
                            </button>
                        )}
                        <button type="button" className={LINK_INLINE} onClick={chooseView}>{t('cowork_home.intro.view', 'Default view')}</button>
                        <button type="button" className={ICON_BUTTON} aria-label={pageName('settings', t)} title={pageName('settings', t)} onClick={() => open({ kind: 'settings' })} data-testid="cowork-preferences">
                            <Settings aria-hidden="true" size={16} />
                        </button>
                    </header>}
                    <CoworkHome admin={administersOrg(user)} embedded={placement.embedded} context={placement.context} returnHome={close} guided={placement.embedded || !dashboard} onAskTask={askTask} onOpenTask={openTask} onOpenPanel={open} seed={seed} />
                    {!placement.embedded && <button type="button" className={LINK_INLINE + ' self-center'} onClick={() => beeTransition(() => setDashboard(!dashboard))}>
                        {dashboard ? t('cowork_task.orb.back', 'Back to the orb') : t('cowork_overview.advanced', 'Advanced')}
                    </button>}
                </div>
            </div>
        </div>
    );
}
