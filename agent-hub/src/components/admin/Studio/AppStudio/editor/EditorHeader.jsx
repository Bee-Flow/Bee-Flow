import {
    ArrowLeft, ChevronDown, Command, Database, Eye, History, Loader2, MoreHorizontal, Pencil, Shield, UploadCloud, Workflow,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CommandPalette from './CommandPalette';
import { useEditorChrome } from './EditorChromeContext';
import EditorToolRow from './EditorToolRow';
import { DataView, RolesView } from './EditorViews';
import LogicaTab from './LogicaTab';
import { countWiredLogic } from './logicRows';
import PublishModal from './PublishModal';
import { toSaveNotices } from './saveNotices';
import { SaveNoticeCapsule, SaveNoticesPanel, SaveStatusChip } from './SaveStatusPill';
import AppIcon from '../../../../icons/AppIcon';
import AnchoredMenu from '../../../../shared/AnchoredMenu';
import ConfirmDialog from '../../../../shared/ConfirmDialog';
import IconButton from '../../../../shared/IconButton';
import { kindTileStyle } from '../../../../shared/kindColors';
import Modal from '../../../../shared/Modal';
import SegmentedControl from '../../../../shared/SegmentedControl';
import StatusActionPill from '../../../../shared/StatusActionPill';
import statusOf from '../../../../shared/statusOf';
import toast from '../../../../shared/Toast';
import { useAppEditor } from '../state/AppEditorContext';
import { listDefinitionRoles } from '../state/definitionOps';
import { studioAppsApi } from '../studioAppsApi';
import useTranslation from '../../../../../hooks/useTranslation';
import { isMac, modKeyLabel } from '../../../../../utils/platform';

/** Focus the AI builder composer (the chat pane tags its textarea). No-op if absent. */
function focusAiComposer() {
    if (typeof document === 'undefined') return;
    const el = document.querySelector('[data-app-ai-composer]');
    if (el && typeof el.focus === 'function') el.focus();
}

const PATH_STEP_RE = /(screens|sections|children)\[(\d+)\]/g;

/**
 * Resolve a server path ("screens[0].sections[1].children[2].props.text") to the
 * screen and component it points at, so "Show me" can go there. Returns null
 * when the path names neither (a stale index, or app-level paths like meta.name).
 */
function resolvePathTarget(definition, path) {
    if (!definition || !path) return null;
    let screen = null;
    let node = null;
    let cursor = null;
    for (const [, kind, index] of path.matchAll(PATH_STEP_RE)) {
        const i = Number(index);
        if (kind === 'screens') {
            screen = definition.screens?.[i] || null;
            cursor = screen;
        } else if (kind === 'sections') {
            cursor = screen?.sections?.[i] || null;
        } else {
            node = cursor?.children?.[i] || null;
            cursor = node;
        }
        if (!cursor) return null;
    }
    if (!screen?.id) return null;
    return { screenId: screen.id, nodeId: node?.id || null };
}

/** The views a header segment can open in place of the canvas. */
export const PANEL_VIEWS = Object.freeze(['data', 'logic', 'roles']);

/**
 * App Studio editor — the top bar (Studio artboard 1b, row 1), and the rows
 * it decides about:
 *
 *   ← · [app tile] name · "Saved · v12" · ‹Edit · Preview · Data · Logic n ·
 *   Roles› · "⚠ 1 to check" · "View as ▾" · [● LIVE | Publish] · ⋯
 *
 * The five segments are one control: Edit and Preview are the canvas's two
 * MODES (AppEditorContext); Data, Logic and Roles are VIEWS that replace the
 * canvas (EditorViews). The header owns which one is open and tells the
 * shell through `onViewChange(view)` so it can hide the canvas and the
 * inspector; a mode change from elsewhere (⌘K "Switch to Preview", a hotkey)
 * closes any open view. Under the header, in EDIT view only, it mounts
 * EditorToolRow — undo/redo, the screen pills and the component chips —
 * so the whole editing chrome lives in two rows.
 *
 * "View as ▾" is a capsule that opens a menu (AnchoredMenu — portalled, so
 * the center column's overflow clip can never cut it off); the publish
 * control is the shared StatusActionPill split over `publishState`
 * (statusOf.app), Live | Publish; ⌘K, version history and "View as role…"
 * sit in the ⋯ menu. The conflict dialog ("changed in another tab") also
 * renders here — the shell owns the conflict state and hands down the two
 * resolutions.
 *
 * All editing controls disable under streamLock; Preview/Close stay live so
 * the user is never trapped while the AI streams.
 */

export default function EditorHeader({
    app,
    onAppUpdated,
    onClose,
    onCommit,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    saveStatus,
    saveError,
    saveNotices,
    onFlush,
    conflict,
    onConflictLoadLatest,
    onConflictOverwrite,
    onConflictDismiss,
    onServerDefinition,
    commandOpen = false,
    onCommandOpenChange,
    onViewChange = null,
    logicView = null,
}) {
    const { t } = useTranslation();
    const { definition, version, screenId, mode, streamLock, previewRole, dispatch } = useAppEditor();
    // The shell's chat-pane handles. "Ask the AI builder" must go through
    // focusAiChat — the pane may be collapsed (display:none), and focusing the
    // composer inside it is a silent no-op. Read through a ref so the memoised
    // command list below never captures a stale chrome value.
    const chromeHandles = useEditorChrome();
    const focusAiRef = useRef(null);
    focusAiRef.current = chromeHandles?.focusAiChat || focusAiComposer;

    // ---- roles (RBAC authoring + view-as-role preview) ---------------------
    // The view-as selector + banner read the definition's mirrored role list
    // ([{ id, name }]); the authoritative model roles are loaded (via useQuery)
    // only inside the Roles view, so the header itself needs no data fetch.
    const roles = listDefinitionRoles(definition);
    const [rolesDirty, setRolesDirty] = useState({ roles: false, rules: false });
    const setPreviewRole = useCallback((roleKey) => dispatch({ type: 'set_preview_role', role: roleKey || null }), [dispatch]);
    // HET GETAL KOMT UIT DEZELFDE MODULE ALS DE TABEL. Stond hier
    // `countLogicMarks`, dat alleen bedrade NODE_EVENTS telt, terwijl de
    // Logica-tab er zes actie-oppervlakken bij heeft: een data_grid met al zijn
    // logica in rowActions gaf 0 — het segment liet het getal weg (het signaal
    // "hier valt niets te zien") boven een tabel met vier regels.
    const logicCount = useMemo(() => countWiredLogic(definition), [definition]);

    // ---- which of the five segments is open --------------------------------
    // Edit/Preview live in the context (`mode`); a panel view is local and
    // wins while set. `view` is the one word both the segments and the shell
    // read.
    const [panelView, setPanelView] = useState(null);
    const view = panelView ?? mode;
    // Data view remembers which subtab to open (⌘K "Open Variables" lands on
    // the Variables subtab); `n` re-keys the view so a repeat request applies.
    const [dataOpen, setDataOpen] = useState({ tab: 'tables', n: 0 });
    // A view someone tried to switch to while Roles held unsaved drafts —
    // the ConfirmDialog below decides.
    const [pendingView, setPendingView] = useState(null);

    useEffect(() => { onViewChange?.(view); }, [view, onViewChange]);

    // A mode change from OUTSIDE the segments (⌘K, a hotkey, an AI turn) means
    // "show me the canvas" — an open view would otherwise hide what the
    // person just asked for.
    const prevModeRef = useRef(mode);
    useEffect(() => {
        if (prevModeRef.current !== mode) {
            prevModeRef.current = mode;
            setPanelView(null);
        }
    }, [mode]);

    const applyView = useCallback((next, opts = {}) => {
        if (next === 'edit' || next === 'preview') {
            setPanelView(null);
            dispatch({ type: 'set_mode', mode: next });
            return;
        }
        if (!PANEL_VIEWS.includes(next)) return;
        if (next === 'data') setDataOpen((prev) => ({ tab: opts.tab || 'tables', n: prev.n + 1 }));
        setPanelView(next);
    }, [dispatch]);

    // Roles and row rules live in each panel's local draft until its own Save
    // button runs, so leaving the Roles view mid-edit is a silent discard.
    const rolesDirtyRef = useRef(rolesDirty);
    rolesDirtyRef.current = rolesDirty;
    const viewRef = useRef(view);
    viewRef.current = view;
    const selectView = useCallback((next, opts = {}) => {
        if (next === viewRef.current && !opts.tab) return;
        const dirty = rolesDirtyRef.current;
        if (viewRef.current === 'roles' && next !== 'roles' && (dirty.roles || dirty.rules)) {
            setPendingView({ next, opts });
            return;
        }
        applyView(next, opts);
    }, [applyView]);

    const leaveRolesAnyway = () => {
        const target = pendingView;
        setPendingView(null);
        setRolesDirty({ roles: false, rules: false });
        if (target) applyView(target.next, target.opts);
    };

    // ---- inline name -------------------------------------------------------
    const [editingName, setEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState(app?.name || '');
    const nameInputRef = useRef(null);
    useEffect(() => {
        if (editingName) nameInputRef.current?.select();
    }, [editingName]);

    const commitName = async () => {
        setEditingName(false);
        const name = nameDraft.trim();
        if (!name || name === app?.name) {
            setNameDraft(app?.name || '');
            return;
        }
        try {
            const updated = await studioAppsApi.updateApp(app.id, { name });
            onAppUpdated?.(updated?.app || updated || { ...app, name });
        } catch (err) {
            setNameDraft(app?.name || '');
            toast.error(err?.message || t('app_studio.header.rename_failed', 'Could not rename the app.'));
        }
    };

    // ---- what the last save reported ---------------------------------------
    // Each entry keeps the node it points at so "Show me" can jump there; a
    // path that no longer resolves (the user deleted it since) just loses the
    // affordance.
    const notices = useMemo(
        () => toSaveNotices(saveNotices).map((n) => ({ ...n, target: resolvePathTarget(definition, n.path) })),
        [saveNotices, definition],
    );
    const [noticesOpen, setNoticesOpen] = useState(false);
    useEffect(() => {
        if (!notices.length) setNoticesOpen(false);
    }, [notices]);

    const showNotice = (entry) => {
        if (!entry.target) return;
        applyView('edit');
        dispatch({ type: 'set_screen', screenId: entry.target.screenId });
        if (entry.target.nodeId) dispatch({ type: 'select_node', nodeId: entry.target.nodeId });
        setNoticesOpen(false);
    };

    // ---- publish -----------------------------------------------------------
    // The audience picker (Private / Entire org / Specific groups) lives in
    // PublishModal; it builds the PATCH payload and reports the updated app back
    // through onAppUpdated. The header only owns open/close.
    const [publishOpen, setPublishOpen] = useState(false);
    // 'behind'  — live app is on an older version than this canvas
    // 'current' — live app matches this canvas
    // 'unknown' — never published, or the row predates publishedVersion; claiming
    //             "up to date" on a guess would be worse than saying nothing.
    const publishedVersion = app?.publishedVersion ?? app?.published_version ?? null;
    const isPublishedFlag = !!(app?.isPublished ?? app?.is_published);
    const publishState = (!isPublishedFlag || publishedVersion == null)
        ? 'unknown'
        : (Number(publishedVersion) === Number(version) ? 'current' : 'behind');
    // The pill's word: statusOf.app folds "never published" and "row predates
    // publishedVersion" into `unknown`; the first is a plain draft and says so.
    const pillStatus = isPublishedFlag ? statusOf.app({ ...app, version }) : 'draft';

    // ---- version history ---------------------------------------------------
    const [versionsOpen, setVersionsOpen] = useState(false);
    const [versions, setVersions] = useState(null); // null = loading
    const [restoringId, setRestoringId] = useState(null);
    useEffect(() => {
        if (!versionsOpen) return undefined;
        let alive = true;
        setVersions(null);
        studioAppsApi.listVersions(app.id)
            .then((res) => { if (alive) setVersions(res?.versions || (Array.isArray(res) ? res : [])); })
            .catch((err) => {
                if (!alive) return;
                setVersions([]);
                toast.error(err?.message || t('app_studio.header.versions_failed', 'Could not load versions.'));
            });
        return () => { alive = false; };
    }, [versionsOpen, app?.id, t]);

    const doRestore = async (versionEntry) => {
        const versionId = versionEntry.id ?? versionEntry.versionId ?? versionEntry.version;
        setRestoringId(versionId);
        try {
            await studioAppsApi.restoreVersion(app.id, versionId);
            const fresh = await studioAppsApi.getApp(app.id);
            const freshApp = fresh?.app || fresh;
            // The app row exposes the optimistic-concurrency version as
            // `definitionVersion` (studioApps.js → sanitizeAppRow); `version` is
            // only there for callers that already normalised it. Handing over
            // undefined leaves autosave on a stale baseVersion → conflict loop.
            onServerDefinition?.(freshApp.definition, freshApp.version ?? freshApp.definitionVersion);
            onAppUpdated?.(freshApp);
            setVersionsOpen(false);
            toast.success(t('app_studio.header.version_restored', 'Version restored.'));
        } catch (err) {
            toast.error(err?.message || t('app_studio.header.restore_failed', 'Restore failed.'));
        } finally {
            setRestoringId(null);
        }
    };

    // ---- close -------------------------------------------------------------
    // The flush RESOLVES on failure (autosave turns every error into a status,
    // it never rejects), so closing has to read the result — a `finally` would
    // throw away work that never reached the server.
    const [closing, setClosing] = useState(false);
    const handleClose = async () => {
        if (closing) return;
        setClosing(true);
        try {
            const res = await onFlush?.();
            if (res && res.ok === false) {
                toast.error(`${res.error || t('app_studio.header.save_failed', 'Saving failed')}. ${t('app_studio.header.close_kept', 'Your changes are still here — the editor stays open.')}`);
                return;
            }
            onClose?.();
        } finally {
            setClosing(false);
        }
    };

    // ---- publish -----------------------------------------------------------
    /**
     * Publishing freezes the definition AS THE SERVER HAS IT. Autosave is
     * debounced, so clicking Publish within that window froze the PREVIOUS
     * draft while the modal promised "a copy of the app as it is now" — the
     * edit you made just before publishing was the one that did not go live,
     * and nothing said so. Closing the editor already flushed for exactly this
     * reason; publishing has more at stake and did not.
     *
     * Same contract as handleClose: flush RESOLVES on failure (autosave turns
     * every error into a status, it never rejects), so the result has to be
     * read. A draft that could not be saved must not be published — it would
     * freeze a version the author cannot see.
     */
    const [preparingPublish, setPreparingPublish] = useState(false);
    // The command palette's action list is memoised on what changes the LIST,
    // so it must not capture this closure directly — it would go stale on
    // `onFlush`, which is exactly the part that has to be current.
    const openPublishRef = useRef(null);
    const openPublish = async () => {
        if (preparingPublish) return;
        setPreparingPublish(true);
        try {
            const res = await onFlush?.();
            if (res && res.ok === false) {
                toast.error(`${res.error || t('app_studio.header.save_failed', 'Saving failed')}. ${t('app_studio.header.publish_not_opened', 'Publishing would freeze the last version that saved, so it has not opened.')}`);
                return;
            }
            setPublishOpen(true);
        } finally {
            setPreparingPublish(false);
        }
    };
    openPublishRef.current = openPublish;

    // ---- the ⋯ menu and the View-as menu -----------------------------------
    const [moreOpen, setMoreOpen] = useState(false);
    const moreAnchorRef = useRef(null);
    const [viewAsOpen, setViewAsOpen] = useState(false);
    const viewAsAnchorRef = useRef(null);

    // Anchor for the portalled save-notices panel. It used to be a plain
    // `absolute right-0 top-full` child of the pill's wrapper — the one header
    // overlay that was not a portal — and the center column's overflow-x-clip
    // cut it off whenever the wrapped header put the pill near the column's
    // left edge. Same cure as every other menu here: AnchoredMenu.
    const saveAnchorRef = useRef(null);

    // ---- command palette actions (all setters are declared by now) ---------
    const commandActions = useMemo(() => {
        const acts = [];
        acts.push({
            id: 'cmd-mode',
            group: t('app_studio.cmd.group_view', 'View'),
            label: mode === 'edit' ? t('app_studio.cmd.switch_preview', 'Switch to Preview') : t('app_studio.cmd.switch_edit', 'Switch to Edit'),
            run: () => selectView(mode === 'edit' ? 'preview' : 'edit'),
        });
        for (const s of definition?.screens || []) {
            acts.push({
                id: `cmd-screen-${s.id}`,
                group: t('app_studio.cmd.group_screen', 'Go to screen'),
                label: t('app_studio.cmd.go_to', 'Go to {name}', { name: s.name || t('app_studio.screens.untitled', 'Screen') }),
                run: () => { selectView('edit'); dispatch({ type: 'set_screen', screenId: s.id }); },
            });
        }
        acts.push({ id: 'cmd-data', group: t('app_studio.cmd.group_data', 'Data'), label: t('app_studio.cmd.open_tables', 'Open Tables'), run: () => selectView('data', { tab: 'tables' }) });
        acts.push({ id: 'cmd-ai', group: t('app_studio.cmd.group_ai', 'AI'), label: t('app_studio.cmd.ask_ai', 'Ask the AI builder'), hint: t('app_studio.cmd.hint_chat', 'chat'), run: () => focusAiRef.current?.() });
        acts.push({ id: 'cmd-variables', group: t('app_studio.cmd.group_app', 'App'), label: t('app_studio.cmd.open_variables', 'Open Variables'), run: () => selectView('data', { tab: 'variables' }) });
        acts.push({ id: 'cmd-logic', group: t('app_studio.cmd.group_app', 'App'), label: t('app_studio.cmd.open_logic', 'Open Logic'), run: () => selectView('logic') });
        acts.push({ id: 'cmd-roles', group: t('app_studio.cmd.group_app', 'App'), label: t('app_studio.cmd.open_roles', 'Open Roles & access'), run: () => selectView('roles') });
        acts.push({ id: 'cmd-versions', group: t('app_studio.cmd.group_app', 'App'), label: t('app_studio.header.version_history', 'Version history'), run: () => setVersionsOpen(true) });
        acts.push({ id: 'cmd-publish', group: t('app_studio.cmd.group_app', 'App'), label: t('app_studio.cmd.publish', 'Publish app'), run: () => { openPublishRef.current?.(); } });
        acts.push({ id: 'cmd-role-owner', group: t('app_studio.cmd.group_preview_as', 'Preview as'), label: t('app_studio.cmd.view_as_owner', 'View as Owner (full view)'), run: () => setPreviewRole(null) });
        for (const r of roles) {
            acts.push({ id: `cmd-role-${r.id}`, group: t('app_studio.cmd.group_preview_as', 'Preview as'), label: t('app_studio.cmd.view_as', 'View as {name}', { name: r.name || r.id }), run: () => setPreviewRole(r.id) });
        }
        return acts;
    // Publishing goes through a ref because it closes over `onFlush`, which
    // is not stable; the deps cover everything that changes the LIST of actions.
    }, [mode, definition, roles, dispatch, selectView, setPreviewRole, t]);

    const closeCommand = useCallback(() => onCommandOpenChange?.(false), [onCommandOpenChange]);

    const onMac = isMac();
    const paletteShortcut = onMac ? `${modKeyLabel()}K` : `${modKeyLabel()}+K`;

    const tile = kindTileStyle('app', { size: 28, pct: 18 });
    const previewRoleName = previewRole ? (roles.find((r) => r.id === previewRole)?.name || previewRole) : null;
    const ownerLabel = t('app_studio.header.view_as_owner', 'Owner');
    const segmentLabel = (text) => <span className="@max-6xl/edhead:sr-only">{text}</span>;

    const publishTitle = publishState === 'behind'
        ? t('app_studio.header.publish_behind_title', 'The version people use is older than what you see here — publish to make these changes live.')
        : publishState === 'current'
            ? t('app_studio.header.publish_current_title', 'Everything on this canvas is live.')
            : t('app_studio.header.publish_unknown_title', 'Choose who can use this app');
    const publishLabel = publishState === 'behind'
        ? t('app_studio.header.publish_changes', 'Publish changes')
        : t('app_studio.header.publish', 'Publish');

    return (
        <>
        {/*
          * The header lives in the CENTER column, whose width is whatever the
          * chat pane and inspector leave over — so it responds to its OWN
          * width (a named @container), not the viewport. Three fit stages:
          *   wide      — every control with its text label
          *   <@6xl     — the five segments keep their icons and drop their
          *               words (sr-only, so their names survive), "View as"
          *               keeps only the role name; the publish pill folds its
          *               own words (StatusActionPill, containerName="edhead")
          *   <@4xl     — the View-as capsule folds into the ⋯ menu
          * flex-wrap is the safety net for anything narrower still: the row
          * wraps instead of painting over the inspector (which is what the
          * old fixed row did — a positioned header paints ABOVE later static
          * siblings, so its overflow landed on top of the panel's text). The
          * artboard's fixed 48px is a deliberate deviation for this header
          * alone: the chat pane and the inspector squeeze this column.
          */}
        <header
            className="@container/edhead relative flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 shrink-0"
            style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)' }}
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

            {/* App identity + rename — the 28px kind tile of every Studio header. */}
            <span style={tile.tile} data-testid="studio-section-kind" data-kind="app" aria-hidden="true">
                <AppIcon name={definition?.meta?.icon || app?.icon || 'LayoutGrid'} style={tile.glyph} />
            </span>
            {editingName ? (
                <input
                    ref={nameInputRef}
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onBlur={commitName}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') commitName();
                        else if (e.key === 'Escape') {
                            setNameDraft(app?.name || '');
                            setEditingName(false);
                        }
                    }}
                    aria-label={t('app_studio.header.name_aria', 'App name')}
                    className="w-48 rounded border px-2 py-1 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                    style={{
                        background: 'var(--bg-secondary)',
                        borderColor: 'var(--accent-primary)',
                        color: 'var(--text-primary)',
                    }}
                />
            ) : (
                <button
                    type="button"
                    onClick={() => !streamLock && setEditingName(true)}
                    title={t('app_studio.header.rename', 'Rename app')}
                    className="group inline-flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-sm font-semibold hover:bg-[var(--bg-tertiary)]"
                    style={{ color: 'var(--text-primary)' }}
                >
                    <span className="truncate max-w-[14rem]">{app?.name || t('app_studio.header.untitled', 'Untitled app')}</span>
                    <Pencil
                        className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                        style={{ color: 'var(--text-tertiary)' }}
                        aria-hidden="true"
                    />
                </button>
            )}

            <SaveStatusChip status={saveStatus} version={version} />

            {/* The five segments — centered */}
            <div className="flex min-w-0 flex-1 justify-center">
                <SegmentedControl
                    size="sm"
                    ariaLabel={t('app_studio.header.view_aria', 'Editor view')}
                    value={view}
                    onChange={(next) => selectView(next)}
                    options={[
                        { value: 'edit', label: segmentLabel(t('app_studio.header.view_edit', 'Edit')), icon: <Pencil className="h-3 w-3" aria-hidden="true" />, disabled: streamLock && mode !== 'edit' },
                        { value: 'preview', label: segmentLabel(t('app_studio.header.view_preview', 'Preview')), icon: <Eye className="h-3 w-3" aria-hidden="true" /> },
                        { value: 'data', label: segmentLabel(t('app_studio.header.view_data', 'Data')), icon: <Database className="h-3 w-3" aria-hidden="true" />, disabled: streamLock },
                        { value: 'logic', label: segmentLabel(t('app_studio.header.view_logic', 'Logic')), icon: <Workflow className="h-3 w-3" aria-hidden="true" />, badge: logicCount || null, disabled: streamLock },
                        { value: 'roles', label: segmentLabel(t('app_studio.header.view_roles', 'Roles')), icon: <Shield className="h-3 w-3" aria-hidden="true" />, disabled: streamLock },
                    ]}
                />
            </div>

            {/* What the server reported about the last save */}
            <div className="shrink-0 empty:hidden" ref={saveAnchorRef}>
                <SaveNoticeCapsule
                    status={saveStatus}
                    error={saveError}
                    onRetry={onFlush}
                    noticeCount={notices.length}
                    noticesOpen={noticesOpen}
                    onToggleNotices={() => setNoticesOpen((open) => !open)}
                />
            </div>
            <SaveNoticesPanel
                open={noticesOpen}
                anchorRef={saveAnchorRef}
                notices={notices}
                onShow={showNotice}
                onClose={() => setNoticesOpen(false)}
            />

            {/* View as role — a capsule that opens a menu */}
            <button
                type="button"
                ref={viewAsAnchorRef}
                onClick={() => setViewAsOpen((open) => !open)}
                aria-label={t('app_studio.header.view_as_aria', 'View as role')}
                aria-haspopup="menu"
                aria-expanded={viewAsOpen}
                title={t('app_studio.header.view_as_title', 'Preview which screens and components a role sees')}
                data-testid="view-as-capsule"
                className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] border px-3 text-xs hover:bg-[var(--bg-tertiary)] @max-4xl/edhead:hidden"
                style={{
                    borderColor: previewRole ? 'var(--accent-primary)' : 'var(--border-default)',
                    background: 'var(--bg-card)',
                    color: 'var(--text-primary)',
                }}
            >
                <Eye className="h-3.5 w-3.5 shrink-0" style={{ color: previewRole ? 'var(--accent-primary)' : 'var(--text-tertiary)' }} aria-hidden="true" />
                <span className="@max-6xl/edhead:hidden" style={{ color: 'var(--text-secondary)' }}>{t('app_studio.header.view_as', 'View as')}</span>
                <span className="font-semibold">{previewRoleName || ownerLabel}</span>
                <ChevronDown className="h-3 w-3" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
            </button>
            <AnchoredMenu
                open={viewAsOpen}
                onClose={() => setViewAsOpen(false)}
                anchorRef={viewAsAnchorRef}
                align="right"
                role="menu"
                minWidth={220}
                className="py-1"
                style={{ background: 'var(--bg-secondary)' }}
            >
                <RoleMenuItem
                    label={t('app_studio.header.view_as_owner_full', 'Owner (full view)')}
                    checked={!previewRole}
                    onClick={() => { setViewAsOpen(false); setPreviewRole(null); }}
                />
                {roles.map((r) => (
                    <RoleMenuItem
                        key={r.id}
                        label={r.name || r.id}
                        checked={previewRole === r.id}
                        onClick={() => { setViewAsOpen(false); setPreviewRole(r.id); }}
                    />
                ))}
            </AnchoredMenu>

            {/* Publish — the shared split pill: status word | the one next action */}
            <StatusActionPill
                status={pillStatus}
                containerName="edhead"
                testId="publish-pill"
                action={{
                    label: publishLabel,
                    ariaLabel: publishLabel,
                    icon: UploadCloud,
                    onClick: openPublish,
                    disabled: streamLock || preparingPublish,
                    title: publishTitle,
                    primary: publishState !== 'current',
                }}
            />

            {/* ⋯ — ⌘K, version history, view-as at narrow widths */}
            <button
                type="button"
                ref={moreAnchorRef}
                onClick={() => setMoreOpen((open) => !open)}
                aria-label={t('app_studio.header.more', 'More')}
                title={t('app_studio.header.more', 'More')}
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--bg-tertiary)]"
                style={{ color: 'var(--text-secondary)' }}
            >
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </button>
            <AnchoredMenu
                open={moreOpen}
                onClose={() => setMoreOpen(false)}
                anchorRef={moreAnchorRef}
                align="right"
                role="menu"
                minWidth={230}
                className="py-1"
                style={{ background: 'var(--bg-secondary)' }}
            >
                <MoreMenuItem
                    icon={Command}
                    label={t('app_studio.header.command_palette', 'Command palette')}
                    hint={paletteShortcut}
                    onClick={() => { setMoreOpen(false); onCommandOpenChange?.(true); }}
                />
                <MoreMenuItem
                    icon={History}
                    label={t('app_studio.header.version_history', 'Version history')}
                    disabled={streamLock}
                    onClick={() => { setMoreOpen(false); setVersionsOpen(true); }}
                />
                {/* Not an embedded <select>: role="menu" allows only menu items,
                    and the command palette already lists a "Preview as" action
                    for the owner view and every role. */}
                <MoreMenuItem
                    icon={Eye}
                    label={t('app_studio.header.view_as_menu', 'View as role…')}
                    onClick={() => { setMoreOpen(false); onCommandOpenChange?.(true); }}
                />
            </AnchoredMenu>

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
                    onPublished={onAppUpdated}
                    // The live draft, not app.definition — publish validates what
                    // the canvas holds, so a blocker's path resolves against it.
                    definition={definition}
                    onRevealNode={({ nodeId, screenId: target }) => {
                        applyView('edit');
                        if (target) dispatch({ type: 'set_screen', screenId: target });
                        if (nodeId) dispatch({ type: 'select_node', nodeId });
                    }}
                />
            ) : null}

            {/* ---- Version history modal ---- */}
            <Modal
                open={versionsOpen}
                onClose={() => setVersionsOpen(false)}
                title={t('app_studio.header.version_history', 'Version history')}
                description={t('app_studio.header.versions_desc', 'Restoring creates a new version — nothing is lost.')}
                size="lg"
            >
                {versions === null ? (
                    <div className="flex items-center gap-2 py-6 text-sm" style={{ color: 'var(--text-tertiary)' }}>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        {t('app_studio.header.versions_loading', 'Loading versions…')}
                    </div>
                ) : versions.length === 0 ? (
                    <p className="py-6 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
                        {t('app_studio.header.versions_empty', 'No saved versions yet — versions appear when the app is published or restored.')}
                    </p>
                ) : (
                    <ul className="divide-y" style={{ borderColor: 'var(--border-default)' }}>
                        {versions.map((entry) => {
                            const versionId = entry.id ?? entry.versionId ?? entry.version;
                            const createdAt = entry.createdAt || entry.created_at;
                            return (
                                <li key={versionId} className="flex items-center gap-3 py-2.5">
                                    <div className="min-w-0 flex-1">
                                        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                                            {entry.label || t('app_studio.header.version_n', 'Version {n}', { n: entry.version ?? versionId })}
                                        </div>
                                        <div className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                            {createdAt ? new Date(createdAt).toLocaleString() : ''}
                                            {entry.createdByName ? ` · ${entry.createdByName}` : ''}
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        disabled={restoringId != null}
                                        onClick={() => doRestore(entry)}
                                        className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                    >
                                        {restoringId === versionId
                                            ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                                            : <History className="h-3 w-3" aria-hidden="true" />}
                                        {t('app_studio.header.restore', 'Restore')}
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </Modal>

            {/* ---- Autosave conflict dialog ---- */}
            {/* Two real choices, so a Modal with explicit buttons: Escape/backdrop
                merely dismisses — the conflict resurfaces on the next save attempt,
                and dismissal must never silently overwrite someone's work. */}
            <Modal
                open={!!conflict}
                onClose={() => onConflictDismiss?.()}
                title={t('app_studio.header.conflict_title', 'This app changed in another tab')}
                description={t('app_studio.header.conflict_desc', 'Someone (or another tab) saved a newer version while you were editing.')}
                size="md"
                footer={(
                    <>
                        <button
                            type="button"
                            onClick={onConflictOverwrite}
                            className="rounded-lg px-4 py-2 text-sm hover:bg-[var(--bg-card-hover)]"
                            style={{ color: 'var(--text-primary)', background: 'var(--bg-tertiary)' }}
                        >
                            {t('app_studio.header.conflict_overwrite', 'Overwrite with mine')}
                        </button>
                        <button
                            type="button"
                            onClick={onConflictLoadLatest}
                            className="rounded-lg px-4 py-2 text-sm font-medium transition-opacity hover:opacity-90"
                            style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)' }}
                        >
                            {t('app_studio.header.conflict_load_latest', 'Load latest')}
                        </button>
                    </>
                )}
            >
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                    <strong>{t('app_studio.header.conflict_load_latest', 'Load latest')}</strong>
                    {' '}
                    {t('app_studio.header.conflict_load_latest_desc', 'replaces your canvas with the newer version (your unsaved changes are kept in this tab’s undo history).')}
                    {' '}
                    <strong>{t('app_studio.header.conflict_overwrite', 'Overwrite with mine')}</strong>
                    {' '}
                    {t('app_studio.header.conflict_overwrite_desc', 'saves your canvas over the newer version.')}
                </p>
            </Modal>

            <ConfirmDialog
                open={pendingView != null}
                title={t('app_studio.header.roles_leave_title', 'Leave without saving?')}
                description={t('app_studio.header.roles_leave_desc', 'Your changes to roles and row rules have not been saved yet. Leaving now discards them.')}
                confirmLabel={t('app_studio.header.roles_leave_confirm', 'Discard changes')}
                cancelLabel={t('app_studio.header.roles_leave_cancel', 'Keep editing')}
                destructive
                onConfirm={leaveRolesAnyway}
                onCancel={() => setPendingView(null)}
            />

            {/* ---- Command palette (⌘K) ---- */}
            <CommandPalette open={!!commandOpen} onClose={closeCommand} actions={commandActions} />
        </header>

        {/* View-as-role banner — a subtle strip while previewing a role. */}
        {previewRole ? (
            <div
                className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b px-3 py-1.5 text-xs"
                data-preview-role-banner={previewRole}
                style={{
                    borderColor: 'var(--border-default)',
                    background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                    color: 'var(--text-secondary)',
                }}
            >
                <Eye className="h-3.5 w-3.5" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                <span>
                    {t('app_studio.header.previewing_as', 'Previewing as')}{' '}
                    <strong style={{ color: 'var(--text-primary)' }}>{previewRoleName}</strong>
                    {' — '}
                    {t('app_studio.header.previewing_desc', 'screens and components hidden from this role are hidden here. Lists and tables still show everything you can see; each person only gets their own rows once they open the app themselves.')}
                </span>
                <button
                    type="button"
                    onClick={() => setPreviewRole(null)}
                    className="font-semibold underline underline-offset-2"
                    style={{ color: 'var(--accent-primary)' }}
                >
                    {t('app_studio.header.exit_preview', 'Exit preview')}
                </button>
            </div>
        ) : null}

        {/* Row 2 — only while the canvas is being edited. */}
        {view === 'edit' ? (
            <EditorToolRow
                onCommit={onCommit}
                canUndo={canUndo}
                canRedo={canRedo}
                onUndo={onUndo}
                onRedo={onRedo}
            />
        ) : null}

        {/* The views that replace the canvas. The shell hides the canvas and
            the inspector while one is open (onViewChange). */}
        {view === 'data' ? (
            <DataView
                key={dataOpen.n}
                app={app}
                definition={definition}
                screenId={screenId}
                onCommit={onCommit}
                dispatch={dispatch}
                disabled={streamLock}
                initialTab={dataOpen.tab}
                onLeave={() => applyView('edit')}
            />
        ) : null}
        {view === 'logic' ? (
            logicView ?? (
                <LogicaTab
                    app={app}
                    definition={definition}
                    onCommit={onCommit}
                    saveNotices={saveNotices}
                    disabled={streamLock}
                    onReveal={({ screenId: target, nodeId }) => {
                        applyView('edit');
                        if (target) dispatch({ type: 'set_screen', screenId: target });
                        if (nodeId) dispatch({ type: 'select_node', nodeId });
                    }}
                />
            )
        ) : null}
        {view === 'roles' ? (
            <RolesView
                app={app}
                definition={definition}
                onCommit={onCommit}
                onDirtyChange={(key, d) => setRolesDirty((prev) => (prev[key] === d ? prev : { ...prev, [key]: d }))}
            />
        ) : null}
        </>
    );
}

/** One row of the ⋯ menu. */
function MoreMenuItem({ icon, label, hint = null, disabled = false, onClick }) {
    const Icon = icon;
    return (
        <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={onClick}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50"
            style={{ color: 'var(--text-primary)' }}
        >
            <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
            <span className="flex-1">{label}</span>
            {hint ? (
                <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{hint}</span>
            ) : null}
        </button>
    );
}

/** One role in the View-as menu — a radio-style item, the current one checked. */
function RoleMenuItem({ label, checked, onClick }) {
    return (
        <button
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            onClick={onClick}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--bg-tertiary)]"
            style={{ color: 'var(--text-primary)' }}
        >
            <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: checked ? 'var(--accent-primary)' : 'transparent', boxShadow: checked ? 'none' : 'inset 0 0 0 1.5px var(--text-tertiary)' }}
            />
            <span className="flex-1">{label}</span>
        </button>
    );
}
