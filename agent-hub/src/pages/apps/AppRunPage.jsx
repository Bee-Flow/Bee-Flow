import { CircleSlash, RefreshCw, Users } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppDataScope from '../../components/admin/Studio/AppStudio/runtime/AppDataScope';
import AppRenderer from '../../components/admin/Studio/AppStudio/runtime/AppRenderer';
import AppShell from '../../components/admin/Studio/AppStudio/runtime/AppShell';
import { buildScope } from '../../components/admin/Studio/AppStudio/runtime/RuntimeContext';
import { CANVAS_GROUND, themeVars } from '../../components/admin/Studio/AppStudio/runtime/themeVars';
import { appDesignProps } from '../../components/admin/Studio/AppStudio/runtime/appDesign';
import AppFontLoader from '../../components/admin/Studio/AppStudio/runtime/AppFontLoader';
import AppVersionBanner from '../../components/admin/Studio/AppStudio/runtime/AppVersionBanner';
import { subscribeAppVersion } from '../../components/admin/Studio/AppStudio/runtime/appVersionSignal';
import { mergeFormValues } from '../../components/admin/Studio/AppStudio/runtime/formValues';
import useActionRunner from '../../components/admin/Studio/AppStudio/runtime/useActionRunner';
import useConfirmDialog from '../../components/admin/Studio/AppStudio/runtime/useConfirmDialog';
import { BrowserRunProvider, useBrowserRunStore } from '../../components/admin/Studio/AppStudio/runtime/BrowserRunContext';
import { studioAppsApi } from '../../components/admin/Studio/AppStudio/studioAppsApi';
import EmptyState from '../../components/shared/EmptyState';
import RequiredConnectionsBanner from '../../components/shared/RequiredConnectionsBanner';
import useTranslation from '../../hooks/useTranslation';
import { API_BASE, authFetch, isNextcloudEmbed } from '../../utils/helpers';
import { rememberAppOpened } from './AppsHomePage';

// Stands in for "this viewer has no role in this app" so role gating stays
// closed instead of falling back to the ungated full view.
const NO_ROLE = '__no_role__';

/**
 * Pre-flight for runAs:'viewer' connectors: when the app pulls data through an
 * integration each user connects THEMSELVES, tell an unconnected viewer up
 * front (the bound components additionally degrade to a "connect first" error
 * state — useAppDataSource's connection_required handling). Renders nothing
 * when every viewer-mode provider is connected or the app has none. Plain
 * effect fetch (not react-query) so the run page keeps rendering in
 * provider-less environments — same rationale as AppDataScope's
 * useOptionalQueryClient.
 */
function ConnectionsPreflight({ appId }) {
    const [providers, setProviders] = useState([]);
    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/data/connectors`);
                if (!res.ok) return;
                const body = await res.json().catch(() => null);
                const list = Array.isArray(body?.connectors) ? body.connectors : [];
                const next = [...new Set(list.filter((c) => c.runAs === 'viewer' && c.integrationId).map((c) => c.integrationId))];
                if (alive) setProviders(next);
            } catch { /* best-effort pre-flight — the banner just stays hidden */ }
        })();
        return () => { alive = false; };
    }, [appId]);

    if (providers.length === 0) return null;
    return (
        // shrink-0: this is a sibling of the renderer inside AppShell's <main>.
        // On a full-height screen the renderer claims the remaining space, and
        // without this the banner would be squeezed instead of the app.
        <div className="shrink-0 px-4 pt-3">
            <RequiredConnectionsBanner
                resourceType="studio_app"
                resourceId={appId}
                providers={providers}
                purpose="to load this app's data"
            />
        </div>
    );
}

/**
 * Bridges AppDataScope's render-prop values back UP to RunSurface: the action
 * runner is hosted ABOVE the data scope (its `vars` feed the scope that
 * dynamic binding filters resolve against), but sequences still need the live
 * `dataState` (formula steps) and the AppDataScope `refresh` (refresh steps).
 * Both flow up here — dataState into state the runner reads via its
 * per-render ref, refresh into a ref behind a stable callback. Sequences only
 * read them asynchronously (on user actions), so the one-commit mirror lag is
 * never observable; the renderer below gets the fresh dataState directly.
 */
function RunBody({
    appId, definition, screenId, onNavigate, onExit, viewer, previewRole,
    actionState, runAction, vars, setVar, forms, screenParams, registerFormValue,
    dataState, refresh, onDataState, refreshRef, versionBanner = null, chrome = 'app',
}) {
    useEffect(() => { onDataState(dataState); }, [onDataState, dataState]);
    useEffect(() => { refreshRef.current = refresh; }, [refreshRef, refresh]);

    const renderer = (
        <AppRenderer
            definition={definition}
            screenId={screenId}
            mode="run"
            actionState={actionState}
            dataState={dataState}
            runAction={runAction}
            currentUser={viewer}
            previewRole={previewRole}
            vars={vars}
            setVar={setVar}
            forms={forms}
            screenParams={screenParams}
            registerFormValue={registerFormValue}
        />
    );

    // 'bare' is the PUBLIC page (pages/apps/PublicAppPage.jsx): no AppShell, so
    // no nav bar, no user menu and no "Alle apps" exit — an anonymous visitor
    // filling in a form has no account to show and nowhere else in the product
    // to go. The connections pre-flight is skipped for the same reason: it asks
    // about per-viewer integrations, which an anonymous visitor cannot connect
    // (and the public transport 404s the call anyway).
    if (chrome === 'bare') {
        return (
            <div className="h-full min-h-0 flex flex-col" style={{ background: CANVAS_GROUND, color: 'var(--text-primary)' }}>
                {versionBanner}
                <div className="flex-1 min-h-0 overflow-auto">{renderer}</div>
            </div>
        );
    }

    return (
        <AppShell
            definition={definition}
            screenId={screenId}
            onNavigate={onNavigate}
            viewer={viewer}
            appId={appId}
            onExit={onExit}
        >
            {versionBanner}
            <ConnectionsPreflight appId={appId} />
            {renderer}
        </AppShell>
    );
}

/**
 * The live run surface: hosts useActionRunner (with a house-style confirm),
 * wraps the renderer in AppDataScope and renders the app in run mode.
 *
 * It owns the formula-scope state the renderer needs:
 *   forms        — { [formName]: values } published by AppForm via
 *                  registerFormValue (feeds form/forms roots)
 *   screenParams — set by onNavigate(screenId, params) from navigate actions
 *                  (feeds screen.params); plain shell navigation clears them
 *   vars         — lifted action-variable state from useActionRunner
 * plus the viewer identity from the runtime payload (currentUser/previewRole).
 *
 * ORDERING (Wave 2B2): AppDataScope lives INSIDE RunSurface — below the
 * action runner — because dynamic binding filters ({kind:'formula'} filter
 * values) resolve against the live scope, and `vars` is runner state. The
 * runner's own data inputs (dataState for sequence formulas, refresh for
 * refresh steps) are mirrored back up by RunBody; see there.
 */
export function RunSurface({ appId, draft, definition, screenId, viewer, onNavigate, versionBanner = null, hideExit = false, chrome = 'app' }) {
    const { confirm, dialog } = useConfirmDialog();
    const [forms, setForms] = useState({});
    const [screenParams, setScreenParams] = useState({});

    // "Alle apps" in the shell's user menu → the published-apps directory.
    // Plain full navigation, the same mechanism as AppsHomePage's card links.
    // Suppressed (onExit=null hides the menu entry) when the app runs as its
    // own Nextcloud page: /app/apps is not a navigable URL inside that iframe,
    // and "leave the app" there means picking another icon in Nextcloud's own
    // top bar.
    const handleExit = useCallback(() => {
        window.location.assign('/app/apps');
    }, []);

    // mergeFormValues keeps `prev` when the values are unchanged, so a form
    // re-publishing what the scope already has cannot re-memo buildScope and
    // ripple a re-render through every bound component on the screen.
    const registerFormValue = useCallback((formName, values) => {
        setForms((prev) => mergeFormValues(prev, formName, values));
    }, []);

    const handleNavigate = useCallback((sid, params) => {
        setScreenParams(params && typeof params === 'object' ? params : {});
        onNavigate(sid);
    }, [onNavigate]);

    // Mirrored up from RunBody (see its docblock).
    const [runnerDataState, setRunnerDataState] = useState({});
    const refreshRef = useRef(null);
    const handleRefresh = useCallback((...args) => refreshRef.current?.(...args), []);

    // The live-browse frame store: created above the runner so its `publish`
    // can be the runner's onBrowseEvent, and provided below to the renderer so
    // a browser_view can read the frames.
    const browseStore = useBrowserRunStore();

    const { actionState, runAction, vars, setVar } = useActionRunner(appId, definition, {
        draft,
        onNavigate: handleNavigate,
        confirm,
        dataState: runnerDataState,
        currentUser: viewer,
        onRefresh: handleRefresh,
        // The same two roots the renderer's scope carries. Without them a step
        // formula reading screen.params.<name> — how a detail screen learns
        // which record it is showing — resolved to undefined.
        forms,
        screen: { id: screenId, params: screenParams },
        onBrowseEvent: browseStore.publish,
    });

    // Role gating mirrors the editor's view-as-role: the owner sees everything.
    // A viewer the server resolved NO role for gets the sentinel, never null —
    // null disables gating entirely in roleAllows(), which would show a viewer
    // without a role every role-gated screen. No role key can equal it (keys
    // start with a lowercase letter), so gated content stays hidden.
    const previewRole = viewer?.isOwner ? 'owner' : (viewer?.roleKey || NO_ROLE);

    // The live scope dynamic binding filters resolve against — buildScope's
    // shape, never a fork. dataState is deliberately absent: the fetch layer
    // must not depend on its own results.
    const scope = useMemo(() => buildScope({
        currentUser: viewer,
        vars,
        forms,
        screen: { id: screenId, params: screenParams },
    }), [viewer, vars, forms, screenId, screenParams]);

    // Background refresh cadence, authored per screen (screen.refreshInterval,
    // in seconds; 0 = off).
    const refreshMs = useMemo(() => {
        const screen = (definition?.screens || []).find((s) => s.id === screenId);
        return (screen?.refreshInterval || 0) * 1000;
    }, [definition, screenId]);

    return (
        <BrowserRunProvider value={browseStore}>
            <AppDataScope
                appId={appId}
                definition={definition}
                screenId={screenId}
                sample={false}
                draft={draft}
                scope={scope}
                refreshMs={refreshMs}
            >
                {(dataState, { refresh }) => (
                    <RunBody
                        appId={appId}
                        definition={definition}
                        screenId={screenId}
                        onNavigate={handleNavigate}
                        onExit={hideExit ? null : handleExit}
                        viewer={viewer}
                        previewRole={previewRole}
                        actionState={actionState}
                        runAction={runAction}
                        vars={vars}
                        setVar={setVar}
                        forms={forms}
                        screenParams={screenParams}
                        registerFormValue={registerFormValue}
                        dataState={dataState}
                        refresh={refresh}
                        onDataState={setRunnerDataState}
                        refreshRef={refreshRef}
                        versionBanner={versionBanner}
                        chrome={chrome}
                    />
                )}
            </AppDataScope>
            {dialog}
        </BrowserRunProvider>
    );
}

/**
 * AppRunPage — the standalone end-user run view for a Studio app.
 * Route: /app/apps/:id (App.jsx); ?draft=1 lets the owner
 * preview the working draft (the server enforces ownership).
 *
 * getRuntime → { id, name, icon, accentColor, definition, viewer, draft? };
 * viewer is { id, name, email, isOwner, roleKey } — the page
 * stamps the app theme (themeVars) on its root and hosts AppShell (top bar +
 * screen nav) around AppRenderer in run mode, with useActionRunner as the
 * live action engine. Toasts fired by actions surface through the shared
 * <Toaster /> that main.jsx mounts once at the app root — standalone pages
 * never mount their own copy (a second Toaster would render every toast
 * twice). Responsive by default: runtime.css stacks the grid below 640px.
 */
export default function AppRunPage({ appId, draft = false }) {
    // Only read at render time (the error screen) — never a dependency of
    // load(): see the GENERIC_LOAD_ERROR note in AppsHomePage.jsx for why a
    // per-render `t` in an effect's dependency list refetches forever.
    const { t } = useTranslation();
    const [state, setState] = useState({ status: 'loading', payload: null, error: null });
    const [screenId, setScreenId] = useState(null);

    // Opened from the app's own entry in Nextcloud's app menu (the connector
    // mounts the iframe with ?ncStudioApp=<id>). Computed once — the param is
    // part of the iframe URL and never changes while the page is mounted.
    const [ncAppMenuEmbed] = useState(() => {
        if (!isNextcloudEmbed()) return false;
        try { return !!new URLSearchParams(window.location.search).get('ncStudioApp'); }
        catch { return false; }
    });

    const load = useCallback(async () => {
        setState({ status: 'loading', payload: null, error: null });
        try {
            const payload = await studioAppsApi.getRuntime(appId, { draft });
            setScreenId(
                payload?.definition?.homeScreenId
                || payload?.definition?.screens?.[0]?.id
                || null,
            );
            setState({ status: 'ready', payload, error: null });
        } catch (err) {
            setState({ status: 'error', payload: null, error: err });
        }
    }, [appId, draft]);

    useEffect(() => { load(); }, [load]);

    // Publishing used to be invisible to anyone already inside the app: the
    // definition is fetched once, so a republish left this session rendering an
    // old app against a new schema. The data calls it makes anyway report the
    // server's published version; when that moves past ours, offer a reload.
    const loadedVersion = state.payload?.appVersion ?? null;
    const [staleVersion, setStaleVersion] = useState(false);
    useEffect(() => {
        setStaleVersion(false);
        if (draft || loadedVersion === null) return undefined;
        return subscribeAppVersion(appId, (version) => {
            if (version !== loadedVersion) setStaleVersion(true);
        });
    }, [appId, draft, loadedVersion]);

    // Browser tab shows the app's name while the page is mounted.
    const appName = state.payload?.name || null;
    useEffect(() => {
        if (!appName) return undefined;
        const previous = document.title;
        document.title = appName;
        return () => { document.title = previous; };
    }, [appName]);

    // APPS-05: opening an app is the whole signal behind the directory's
    // "Recently used" section. It is stamped HERE, at the destination, rather
    // than on the tile that was clicked, so a bookmark, a link from a colleague
    // and the sidebar all count exactly like a tile does. Two things it is
    // deliberately not: it never fires for a `draft` preview (that is the
    // builder inspecting their own work, not a reader reaching for a tool), and
    // it never fires for a load that failed — a 404 is not an open. The record
    // stays on this device in per-user scoped storage; see AppsHomePage.
    const openedAppId = state.status === 'ready' && !draft ? appId : null;
    useEffect(() => { rememberAppOpened(openedAppId); }, [openedAppId]);

    const definition = state.payload?.definition || null;

    if (state.status === 'loading') {
        return (
            <div
                className="h-full min-h-0 flex flex-col animate-pulse"
                style={{ background: 'var(--bg-primary)' }}
                role="status"
                aria-label={t('apps.run.loading_label', 'Loading app')}
            >
                <div
                    className="shrink-0 flex items-center gap-3 border-b px-4 py-2.5"
                    style={{ borderColor: 'var(--border-default)', background: 'var(--bg-card)' }}
                >
                    <div className="h-7 w-7 rounded-md" style={{ background: 'var(--bg-secondary)' }} />
                    <div className="h-3.5 w-36 rounded" style={{ background: 'var(--bg-secondary)' }} />
                </div>
                <div className="flex-1 w-full max-w-[960px] mx-auto p-4 space-y-3">
                    <div className="h-6 w-1/3 rounded" style={{ background: 'var(--bg-secondary)' }} />
                    <div className="h-24 w-full rounded-lg" style={{ background: 'var(--bg-secondary)' }} />
                    <div className="h-40 w-full rounded-lg" style={{ background: 'var(--bg-secondary)' }} />
                </div>
                <span className="sr-only">{t('apps.loading_short', 'Loading…')}</span>
            </div>
        );
    }

    if (state.status === 'error') {
        const status = state.error?.status;
        // The server distinguishes "published to groups you are not in" (403
        // not_in_audience — you are in the org, the app exists, the owner can
        // widen it) from the uniform 404 a stranger gets. Inside Nextcloud the
        // app's icon is instance-wide, so this is the screen a colleague
        // outside the audience lands on; it has to say what to do about it.
        const restricted = status === 403 && state.error?.code === 'not_in_audience';
        const notAvailable = status === 403 || status === 404;
        let title, description;
        if (restricted) {
            title = t('apps.run.restricted_title', 'This app is shared with specific groups');
            description = t('apps.run.restricted_body', 'It is published to specific groups in your organization and you are not in one of them. Ask the app’s owner or your administrator to share it with your group.');
        } else if (notAvailable) {
            title = t('apps.run.not_available_title', 'This app is not available to you');
            description = t('apps.run.not_available_body', 'It may be unpublished, or you may not have access. Ask the app’s owner to publish it or share it with your group.');
        } else {
            title = t('apps.run.load_failed_title', 'Could not load this app');
            description = state.error?.message || t('apps.run.load_failed_body', 'Something went wrong while loading the app.');
        }
        return (
            <div className="h-full" style={{ background: 'var(--bg-primary)' }}>
                <EmptyState
                    icon={restricted ? <Users className="w-12 h-12" /> : <CircleSlash className="w-12 h-12" />}
                    title={title}
                    description={description}
                    action={{
                        label: t('apps.run.try_again', 'Try again'),
                        onClick: load,
                        variant: 'secondary',
                        icon: <RefreshCw className="w-4 h-4" />,
                    }}
                />
            </div>
        );
    }

    const design = appDesignProps(definition);
    return (
        <div
            className={`h-full min-h-0${design.className ? ` ${design.className}` : ''}`}
            style={{ ...themeVars(definition?.theme), ...design.style }}
        >
            <AppFontLoader definition={definition} />
            <RunSurface
                appId={appId}
                draft={draft}
                definition={definition}
                screenId={screenId}
                viewer={state.payload?.viewer || null}
                onNavigate={setScreenId}
                versionBanner={staleVersion ? <AppVersionBanner onReload={load} /> : null}
                hideExit={ncAppMenuEmbed}
            />
        </div>
    );
}
