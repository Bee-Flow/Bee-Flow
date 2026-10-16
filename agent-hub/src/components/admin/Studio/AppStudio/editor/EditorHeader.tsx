import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { useEditorChrome } from './EditorChromeContext';
import AppIdentity from './header/AppIdentity';
import ConflictDialog from './header/ConflictDialog';
import { PublishPill, SaveNoticesControl, ViewSegments } from './header/HeaderControls';
import { PANEL_VIEWS, focusAiComposer, publishStateOf, resolvePathTarget } from './header/headerModel';
import type { HeaderApp, HeaderView, RevealTarget } from './header/headerModel';
import { MoreMenu, ViewAsMenu } from './header/HeaderMenus';
import { HeaderViewRows, LeaveRolesDialog, PreviewRoleBanner } from './header/HeaderRows';
import { useCommandActions } from './header/useCommandActions';
import type { CommandAction, DefinitionRole } from './header/useCommandActions';
import { useFlushGuards } from './header/useFlushGuards';
import type { FlushResult } from './header/useFlushGuards';
import { useHeaderView } from './header/useHeaderView';
import VersionHistoryModal from './header/VersionHistoryModal';
import CommandPalette from './CommandPalette';
import LogicaTabJs from './LogicaTab';
import { countWiredLogic } from './logicRows';
import PublishModal from './PublishModal';
import { toSaveNotices } from './saveNotices';
import type { SavePayload } from './saveNotices';
import { SaveStatusChip as SaveStatusChipJs } from './SaveStatusPill';
import IconButton from '../../../../shared/IconButton';
import { managedOf, managedRefusalOf } from '../../../../shared/managedPart';
import type { ManagedBannerInfo } from '../../../../shared/managedPart';
import ManagedPartBanner from '../../../../shared/ManagedPartBanner';
import type { AppDefinition } from '../inspector/appDefinition';
import { useAppEditorState } from '../state/appEditorState';
import { listDefinitionRoles } from '../state/definitionOps';
import useTranslation from '../../../../../hooks/useTranslation';

export { PANEL_VIEWS };

// SaveStatusPill is TypeScript now; the alias keeps the compiled text.
const SaveStatusChip = SaveStatusChipJs;
// Typed views of .jsx siblings, whose `= null` / `= []` defaults would
// otherwise type those props as null-only (or never[]).
const LogicaTab = LogicaTabJs as unknown as ComponentType<{
    app: unknown;
    definition: unknown;
    onCommit?: unknown;
    onReveal: (target: { screenId?: string | null; nodeId?: string | null }) => void;
    saveNotices?: unknown;
    disabled?: boolean;
}>;

/**
 * App Studio editor — the top bar (Studio artboard 1b, row 1), and the rows
 * it decides about:
 *
 *   ← · [app tile] name · "Saved · v12" · ‹Edit · Preview · Data · Logic n ·
 *   Roles› · "⚠ 1 to check" · "View as ▾" · [● LIVE | Publish] · ⋯
 *
 * The five segments are one control: Edit and Preview are the canvas's two
 * MODES (AppEditorContext); Data, Logic and Roles are VIEWS that replace the
 * canvas (EditorViews). The header owns which one is open (header/
 * useHeaderView) and tells the shell through `onViewChange(view)` so it can
 * hide the canvas and the inspector; a mode change from elsewhere (⌘K
 * "Switch to Preview", a hotkey) closes any open view. Under the header, in
 * EDIT view only, it mounts EditorToolRow — undo/redo, the screen pills and
 * the component chips — so the whole editing chrome lives in two rows.
 *
 * "View as ▾" is a capsule that opens a menu (header/HeaderMenus); the
 * publish control is the shared StatusActionPill split over `publishState`
 * (statusOf.app), Live | Publish; ⌘K, version history and "View as role…"
 * sit in the ⋯ menu. The conflict dialog ("changed in another tab") also
 * renders here — the shell owns the conflict state and hands down the two
 * resolutions.
 *
 * All editing controls disable under streamLock; Preview/Close stay live so
 * the user is never trapped while the AI streams.
 *
 * The header lives in the CENTER column, whose width is whatever the chat
 * pane and inspector leave over — so it responds to its OWN width (a named
 * @container/edhead), not the viewport. Three fit stages:
 *   wide      — every control with its text label
 *   <@6xl     — the five segments keep their icons and drop their words
 *               (sr-only, so their names survive), "View as" keeps only the
 *               role name; the publish pill folds its own words
 *               (StatusActionPill, containerName="edhead")
 *   <@4xl     — the View-as capsule folds into the ⋯ menu
 * flex-wrap is the safety net for anything narrower still: the row wraps
 * instead of painting over the inspector (which is what the old fixed row did
 * — a positioned header paints ABOVE later static siblings, so its overflow
 * landed on top of the panel's text). The artboard's fixed 48px is a
 * deliberate deviation for this header alone: the chat pane and the
 * inspector squeeze this column.
 */

export interface EditorHeaderProps {
    app: HeaderApp;
    onAppUpdated?: (app: HeaderApp) => void;
    onClose?: () => void;
    onCommit: (def: AppDefinition) => void;
    canUndo?: boolean;
    canRedo?: boolean;
    onUndo?: () => void;
    onRedo?: () => void;
    saveStatus?: string;
    saveError?: string | null;
    saveNotices?: SavePayload | null;
    onFlush?: () => Promise<FlushResult> | FlushResult;
    conflict?: unknown;
    onConflictLoadLatest?: () => void;
    onConflictOverwrite?: () => void;
    onConflictDismiss?: () => void;
    onServerDefinition?: (definition: AppDefinition | null | undefined, version: unknown) => void;
    commandOpen?: boolean;
    onCommandOpenChange?: (open: boolean) => void;
    onViewChange?: ((view: HeaderView) => void) | null;
    logicView?: ReactNode;
}

/**
 * Managed by a Solution stage (design 9). `managed` rides on the row
 * (studioAppsApi.getApp carries it over from the GET). A refused write on a
 * tab opened before the stage took the app over (409 managed_part) turns the
 * same switch. Managed means read-only for real: the canvas is held in
 * Preview, the AI builder and Restore are gone, and Publish becomes the
 * audience picker alone.
 */
function useManaged(app: HeaderApp, mode: string, dispatch: ReturnType<typeof useAppEditorState>['dispatch']) {
    const [refusal, setRefusal] = useState<ManagedBannerInfo | null>(null);
    const managedPart = managedOf(app) ?? refusal?.managed ?? null;
    const isManaged = !!managedPart || refusal != null;
    const noteRefusal = useCallback((err: unknown) => {
        const info = managedRefusalOf(err);
        if (info) setRefusal(info);
        return !!info;
    }, []);
    useEffect(() => {
        if (isManaged && mode === 'edit') dispatch({ type: 'set_mode', mode: 'preview' });
    }, [isManaged, mode, dispatch]);
    return { refusal, managedPart, isManaged, noteRefusal };
}

export default function EditorHeader({
    app, onAppUpdated, onClose, onCommit, canUndo, canRedo, onUndo, onRedo, saveStatus, saveError, saveNotices,
    onFlush, conflict, onConflictLoadLatest, onConflictOverwrite, onConflictDismiss, onServerDefinition,
    commandOpen = false, onCommandOpenChange, onViewChange = null, logicView = null,
}: EditorHeaderProps) {
    const { t } = useTranslation();
    const { definition, version, screenId, mode, streamLock, previewRole, dispatch } = useAppEditorState();
    const { refusal, managedPart, isManaged, noteRefusal } = useManaged(app, mode, dispatch);
    // The shell's chat-pane handles. "Ask the AI builder" must go through
    // focusAiChat — the pane may be collapsed (display:none), and focusing the
    // composer inside it is a silent no-op. Read through a ref so the memoised
    // command list never captures a stale chrome value.
    const chromeHandles = useEditorChrome() as { focusAiChat?: () => void } | null;
    const focusAiRef = useRef<(() => void) | null>(null);
    focusAiRef.current = chromeHandles?.focusAiChat || focusAiComposer;

    // ---- roles (RBAC authoring + view-as-role preview) ---------------------
    // The view-as selector + banner read the definition's mirrored role list
    // ([{ id, name }]); the authoritative model roles are loaded (via useQuery)
    // only inside the Roles view, so the header itself needs no data fetch.
    const roles = listDefinitionRoles(definition) as DefinitionRole[];
    const setPreviewRole = useCallback((roleKey: string | null) => dispatch({ type: 'set_preview_role', role: roleKey || null }), [dispatch]);
    // THE NUMBER COMES FROM THE SAME MODULE AS THE TABLE. This used to be
    // `countLogicMarks`, which counts only wired NODE_EVENTS, while the Logic
    // tab adds six action surfaces: a data_grid with all its logic in
    // rowActions gave 0 — the segment dropped the number (the signal "nothing
    // to see here") above a table with four rows.
    const logicCount = useMemo(() => countWiredLogic(definition), [definition]);
    const { view, dataOpen, pendingView, setPendingView, setRolesDirty, applyView, selectView, leaveRolesAnyway } = useHeaderView(mode, dispatch, onViewChange);

    // ---- what the last save reported ---------------------------------------
    // Each entry keeps the node it points at so "Show me" can jump there; a
    // path that no longer resolves (the user deleted it since) just loses the
    // affordance.
    const notices = useMemo(
        () => toSaveNotices(saveNotices).map((n) => ({ ...n, target: resolvePathTarget(definition, n.path) })),
        [saveNotices, definition],
    );
    const showNotice = (target: RevealTarget) => {
        applyView('edit');
        dispatch({ type: 'set_screen', screenId: target.screenId });
        if (target.nodeId) dispatch({ type: 'select_node', nodeId: target.nodeId });
    };
    const reveal = ({ screenId: target, nodeId }: { screenId?: string | null; nodeId?: string | null }) => {
        applyView('edit');
        if (target) dispatch({ type: 'set_screen', screenId: target });
        if (nodeId) dispatch({ type: 'select_node', nodeId });
    };

    const { publishState, pillStatus } = publishStateOf(app, version);
    const { handleClose, publishOpen, setPublishOpen, preparingPublish, openPublish, openPublishRef } = useFlushGuards({ t, isManaged, onFlush, onClose });
    const [versionsOpen, setVersionsOpen] = useState(false);
    const openVersions = useCallback(() => setVersionsOpen(true), []);

    const commandActions = useCommandActions({ t, mode, definition, roles, isManaged, dispatch, selectView, setPreviewRole, openVersions, focusAiRef, openPublishRef });
    const closeCommand = useCallback(() => onCommandOpenChange?.(false), [onCommandOpenChange]);

    const previewRoleName = previewRole ? (roles.find((r) => r.id === previewRole)?.name || previewRole) : null;

    return (
        <>
        <header
            className="@container/edhead relative flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 shrink-0 border-[var(--border-default)] bg-[var(--bg-secondary)]"
            data-testid="app-editor-header"
        >
            {/* Back — flushes pending saves first (handleClose). */}
            <IconButton
                ariaLabel={t('app_studio.header.close', 'Close editor')}
                title={t('app_studio.header.back_to_apps', 'Back to Apps')}
                size="md"
                onClick={handleClose}
            >
                <ArrowLeft />
            </IconButton>

            <AppIdentity app={app} icon={(definition?.meta as { icon?: string } | undefined)?.icon} locked={streamLock} isManaged={isManaged} noteRefusal={noteRefusal} onAppUpdated={onAppUpdated} />

            <SaveStatusChip status={saveStatus} version={version} />

            <ViewSegments view={view} onSelect={selectView} isManaged={isManaged} streamLock={streamLock} editing={mode === 'edit'} logicCount={logicCount} />

            <SaveNoticesControl status={saveStatus} error={saveError} onRetry={onFlush} notices={notices} onShow={showNotice} />

            <ViewAsMenu roles={roles} previewRole={previewRole} previewRoleName={previewRoleName} setPreviewRole={setPreviewRole} />

            <PublishPill publishState={publishState} pillStatus={pillStatus} isManaged={isManaged} disabled={streamLock || preparingPublish} onPublish={openPublish} />

            <MoreMenu streamLock={streamLock} onOpenCommand={() => onCommandOpenChange?.(true)} onOpenVersions={openVersions} />

            {/* ---- Publish modal ---- */}
            {/* Mounted only while open: PublishModal runs react-query
                (useOrgDirectory) for the group picker, so keeping it out of the
                tree until needed avoids requiring a QueryClient for the whole
                editor chrome (same rationale as TablesManager in DataView). */}
            {publishOpen ? (
                <PublishModal
                    open={publishOpen}
                    onClose={() => setPublishOpen(false)}
                    app={app}
                    managed={isManaged}
                    onPublished={onAppUpdated}
                    // The live draft, not app.definition — publish validates what
                    // the canvas holds, so a blocker's path resolves against it.
                    definition={definition}
                    onRevealNode={reveal}
                />
            ) : null}

            <VersionHistoryModal
                open={versionsOpen}
                onClose={() => setVersionsOpen(false)}
                app={app}
                isManaged={isManaged}
                noteRefusal={noteRefusal}
                onServerDefinition={onServerDefinition}
                onAppUpdated={onAppUpdated}
            />

            <ConflictDialog open={!!conflict} onLoadLatest={onConflictLoadLatest} onOverwrite={onConflictOverwrite} onDismiss={onConflictDismiss} />

            <LeaveRolesDialog open={pendingView != null} onConfirm={leaveRolesAnyway} onCancel={() => setPendingView(null)} />

            {/* ---- Command palette (⌘K) ---- */}
            <CommandPalette open={!!commandOpen} onClose={closeCommand} actions={commandActions} />
        </header>

        {/* A Solution stage manages this app: read-only, and where to change it. */}
        {isManaged ? <ManagedPartBanner managed={managedPart} notDeployed={refusal?.reason === 'not_deployed'} /> : null}

        {previewRole ? <PreviewRoleBanner previewRole={previewRole} previewRoleName={previewRoleName} onExit={() => setPreviewRole(null)} /> : null}

        <HeaderViewRows
            view={view} app={app} definition={definition} screenId={screenId} streamLock={streamLock} dispatch={dispatch}
            dataOpen={dataOpen}
            renderLogic={() => logicView ?? <LogicaTab app={app} definition={definition} onCommit={onCommit} saveNotices={saveNotices} disabled={streamLock} onReveal={reveal} />}
            onCommit={onCommit} canUndo={canUndo} canRedo={canRedo} onUndo={onUndo} onRedo={onRedo}
            onLeaveData={() => applyView('edit')}
            onRolesDirtyChange={(key, d) => setRolesDirty((prev) => (prev[key] === d ? prev : { ...prev, [key]: d }))}
        />
        </>
    );
}
