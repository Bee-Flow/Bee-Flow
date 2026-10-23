import type React from 'react';
import type AppShell from '../../components/admin/Studio/AppStudio/runtime/AppShell';
import type { AppDefinition } from '../../components/admin/Studio/AppStudio/inspector/appDefinition';
import type { UserMenuViewer } from '../../components/admin/Studio/AppStudio/runtime/shell/UserMenu';
import type { NavigateFn } from '../../components/admin/Studio/AppStudio/runtime/actionRunner/runnerContext';
import type { ActionState, RunOpts, Vars } from '../../components/admin/Studio/AppStudio/runtime/actionRunner/core';
import type { DataState } from '../../components/admin/Studio/AppStudio/runtime/DataContext';

export type ShellDefinition = NonNullable<React.ComponentProps<typeof AppShell>['definition']> & AppDefinition;

/** The run payload of GET /api/studio-apps/:id/runtime. */
export interface RuntimePayload {
    id?: string;
    name?: string;
    icon?: string;
    accentColor?: string;
    appVersion?: number | string | null;
    definition?: ShellDefinition | null;
    viewer?: UserMenuViewer | null;
    draft?: boolean;
}

export interface RuntimeLoadError {
    status?: number;
    code?: string;
    message?: string;
}

export type RunState =
    | { status: 'loading'; payload: null; error: null }
    | { status: 'ready'; payload: RuntimePayload; error: null }
    | { status: 'error'; payload: null; error: RuntimeLoadError | null };

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
export interface ConnectionsPreflightProps {
    appId: string | null;
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
export interface RunBodyProps {
    appId: string | null;
    definition: ShellDefinition | null;
    screenId: string | null;
    onNavigate: NavigateFn | null;
    onExit: (() => void) | null;
    viewer: UserMenuViewer | null;
    previewRole: string;
    actionState: ActionState;
    runAction: (actionId: string, opts?: RunOpts) => Promise<void>;
    vars: Vars;
    setVar: (name: string, value: unknown) => void;
    forms: Record<string, Record<string, unknown>>;
    screenParams: { recordId?: string };
    registerFormValue: (formName: string | null, values: Record<string, unknown> | null | undefined) => void;
    versionBanner?: React.JSX.Element | null;
    dataState: DataState;
    refresh: (scopeArg?: { tableId?: string | null; datasetId?: string | null } | null) => Promise<void>;
    onDataState: React.Dispatch<React.SetStateAction<DataState>>;
    refreshRef: React.RefObject<RunBodyProps['refresh'] | null>;
    chrome?: string;
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
export interface RunSurfaceProps {
    appId: string | null;
    draft: boolean;
    definition: ShellDefinition | null;
    screenId: string | null;
    viewer: UserMenuViewer | null;
    onNavigate: (screenId: string) => void;
    versionBanner?: React.JSX.Element | null;
    hideExit?: boolean;
    chrome?: string;
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
export interface AppRunPageProps {
    appId: string | null;
    draft?: boolean;
}
