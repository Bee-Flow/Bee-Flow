import { X, Search, Upload } from 'lucide-react';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import BuilderShell from './Builder/BuilderShell';
import { describeCron } from './Builder/flow/scheduleBuilderUtils';
import { patternOriginOf } from './Builder/usePatternOrigin';
import { buildMessageFromPattern } from './patternMessage';
import useAutomationLibrary from './useAutomationLibrary';
import useAutomationRouting from './useAutomationRouting';
import { useTranslation } from '../../hooks/useTranslation';
import { releaseStudioChrome } from '../../hooks/useStudioChrome';
import BuildingBlocksGroup from '../admin/Studio/AutomationsStudio/BuildingBlocksGroup';
import CreateMenuButton from '../admin/Studio/AutomationsStudio/CreateMenuButton';
import DeleteToTrashDialog from '../admin/Studio/AutomationsStudio/DeleteToTrashDialog';
import FolderedAutomationList, { MoveToFolderDialog } from '../admin/Studio/AutomationsStudio/FolderedAutomationList';
import QuickSwitcher from '../admin/Studio/AutomationsStudio/QuickSwitcher';
import AutomationRow from '../admin/Studio/AutomationsStudio/AutomationRow';
import AutomationsLauncher from '../admin/Studio/AutomationsStudio/AutomationsLauncher';
import { parseAppRefParam, stickyFrom } from '../admin/Studio/studioRoutes';
import { useEntitlements } from '../licensing/EntitlementsContext';
import Modal from '../shared/Modal';
import { toast } from '../shared/Toast';
import useConfirm from '../shared/useConfirm';

export default function AITasksDesigner({ initialTaskId = null, initialStepId = null, initialFlowletKey = null, initialBuilderView = null, initialRunId = null, initialRunStepId = null, initialFrom = null, onNavigate, embedded = false, user = null, onEditingChange }) {
    const { confirm, confirmDialog } = useConfirm();
    const { t } = useTranslation();
    // Unified entitlements snapshot — replaces the legacy user?.betaFeatures
    // reads so the UI matches the server's requireCapability gating exactly
    // (super-admins are granted every beta by the resolver itself).
    const ent = useEntitlements();

    const [builderAutomationId, setBuilderAutomationId] = useState(null); // null = list, string = open builder
    // Which tab the builder opens on (e.g. 'history' from a "View executions"
    // affordance). Consumed once on mount, then cleared.
    const [builderInitialTab, setBuilderInitialTab] = useState(null);
    // URL ?view= word → builder tab id. The id stays 'history' (BFSF-343);
    // only the URL and the labels say "runs".
    const viewToTab = (view) => (view === 'runs' ? 'history' : (view === 'settings' || view === 'versions' ? view : null));
    const [openingBuilder, setOpeningBuilder] = useState(false);
    // A brand-new automation has no id in `builderAutomationId` (it stays '')
    // until BuilderShell lazily creates the row server-side. `liveAutomationId`
    // carries the id it reports back so the URL/refresh path can pick it up.
    const [liveAutomationId, setLiveAutomationId] = useState(null);
    // Bumped every time the sidebar Plus opens a NEW builder. Part of the
    // BuilderShell `key`: a brand-new build keeps builderAutomationId === ''
    // for its whole life (the lazily-created id only lands in
    // liveAutomationId, deliberately never in the key), so WITHOUT the nonce
    // a second Plus while a new/just-finalized build is open re-used the same
    // 'new' key — no remount — and the previous flow's chat + draft bled into
    // the "new" automation.
    const [newBuilderNonce, setNewBuilderNonce] = useState(0);
    // Automation list — fetched up here so the sidebar shares one source of truth
    // and we can power Cmd/Ctrl+K + the right-pane builder from the same data.
    // Sidebar folders — org-wide, one level. Kept beside the list rather than
    // inside it: the list is per-user, the folders are shared.
    const [movingAutomation, setMovingAutomation] = useState(null);
    const importInputRef = useRef(null);
    const [presetChatInput, setPresetChatInput] = useState(''); // seeded from EmptyState examples
    const [autoSendInput, setAutoSendInput] = useState(null); // "Build it directly" — auto-fire this spec in a fresh builder
    // The "Find repeating work" pattern a fresh builder was opened from, so
    // the builder can record `built` once that build is done. Cleared with
    // the two inputs above whenever a builder opens for anything else.
    const [patternOrigin, setPatternOrigin] = useState(null);
    // Reusable Steps (kind='block') — own builder + own list. Always available
    // wherever automations are (no separate feature flag).
    const [builderStepId, setBuilderStepId] = useState(null); // null=list · ''=new · id=editing
    const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
    // BFSF-404: the persistent sidebar is removed from the tree (not just
    // collapsed) the moment a builder is open — this flyout is the only
    // in-editor way back to the list + its per-item actions menu.
    const [listFlyoutOpen, setListFlyoutOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    // The flyout's filter takes the focus when it opens (Modal's initialFocus),
    // not the first control, the "+" button.
    const flyoutFilterRef = useRef(null);
    // Signal upward (Studio → AgentHub) when the BuilderShell is open so the
    // outer chrome can collapse for a fullscreen edit, mirroring AgentStudio.
    const automationEditing = builderAutomationId !== null || openingBuilder || builderStepId !== null;
    const {
        automationApi,
        automations, setAutomations,
        folders, automationsLoading,
        pendingDeleteAutomation, setPendingDeleteAutomation,
        steps, stepsLoading, activeRunIds,
        fetchAutomations, fetchFolders, createFolder, renameFolder, deleteFolder, moveToFolder,
        fetchSteps, onDeleteStep,
        toggleAutomation, requestDeleteAutomation, confirmDeleteAutomation,
        duplicateAutomation, exportAutomationJson, importAutomationFile, copyAutomationId,
    } = useAutomationLibrary({
        confirm, builderAutomationId, openingBuilder, builderStepId,
        setBuilderAutomationId, setBuilderInitialTab, setBuilderStepId, setOpeningBuilder,
    });


    // The id of the automation currently open in the editor. Drives the
    // URL path so a refresh (or browser back/forward) reopens it. The builder
    // id wins; a brand-new draft falls back to the id BuilderShell reports once
    // it lazily creates the row.
    const selectedAutomationId = builderAutomationId || liveAutomationId || null;

    // ── ?from=app:… — the button this builder was opened from ──────────────
    // The rule itself lives beside the `?from=` contract in studioRoutes.js —
    // it is about what the token means, not about this component.
    const fromRef = useRef({ automationId: initialTaskId || null, token: initialFrom || null });
    fromRef.current = stickyFrom(fromRef.current, selectedAutomationId);
    const activeFromToken = fromRef.current.token;
    const activeAppRef = useMemo(() => parseAppRefParam(activeFromToken), [activeFromToken]);

    // Editing-signal: only the Automations builder requests fullscreen chrome
    // collapse. Editing a regular automation keeps the Studio top-tabs visible
    // so users don't lose their place — automations is a section inside Studio,
    // not a separate screen.
    useEffect(() => {
        onEditingChange?.(automationEditing);
        return () => { onEditingChange?.(false); };
    }, [automationEditing, onEditingChange]);

    // Never leave the flyout "open" in state once its only trigger (an open
    // builder) is gone — otherwise re-entering a builder later could flash it.
    useEffect(() => {
        if (!automationEditing) setListFlyoutOpen(false);
    }, [automationEditing]);

    // The Studio menu (and browser fullscreen) may be hidden from inside the
    // builder; the list has to bring them back when the builder closes.
    useEffect(() => {
        if (!automationEditing) releaseStudioChrome();
    }, [automationEditing]);
    useEffect(() => releaseStudioChrome, []);


    const automationsAllowed = !ent.loading && ent.can('automations');

    const { handleScopeChange, pushBuilderState, stepUrlAdoptedRef } = useAutomationRouting({
        initialTaskId, initialFlowletKey, initialStepId, embedded, onNavigate,
        automations, selectedAutomationId, builderAutomationId, liveAutomationId,
        builderStepId, activeFromToken,
        setBuilderAutomationId, setBuilderStepId, setOpeningBuilder, setLiveAutomationId,
    });

    // ── Cmd/Ctrl+K — quick switcher ──────────────────────────────────────
    useEffect(() => {
        if (!embedded) return;
        const onKey = (e) => {
            const isModK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
            if (!isModK) return;
            // Only intercept when no other modifier surface owns it (ignore
            // shift/alt combinations to leave room for browser shortcuts).
            if (e.shiftKey || e.altKey) return;
            e.preventDefault();
            setQuickSwitcherOpen(true);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [embedded]);

    const quickSwitcherItems = useMemo(() => automations.map(it => ({
            id: it.id,
            kind: 'automation',
            kindLabel: 'Automation',
            title: it.title || 'Untitled automation',
            // Readable, not raw: `0 9 * * *` in a quick-switcher subtitle
            // helps nobody pick the right automation.
            subtitle: it.triggerType + (it.scheduleCron ? ` · ${describeCron(it.scheduleCron)}` : ''),
    })), [automations]);

    const onPickFromSwitcher = useCallback((item) => {
        setQuickSwitcherOpen(false);
        // Jumping to another automation leaves the previous one's builder state
        // (open run, forced tab, an open Step builder) behind — carrying any
        // of it across reads as the new automation misbehaving.
        setBuilderInitialTab(null);
        setBuilderStepId(null);
        stepUrlAdoptedRef.current = true;
        setBuilderAutomationId(item.id);
    }, [stepUrlAdoptedRef]);

    // ── The Studio layout: sidebar + detail shell ─────────────────────────
    // Filter the active list by the search query (case-insensitive
    // match on title; cheap enough to do every render). Power-user
    // search is also via Cmd/Ctrl+K — this input is the discoverable
    // route for everyone else.
    const q = searchQuery.trim().toLowerCase();
    const visibleAutomations = q
        ? automations.filter(a => (a.title || '').toLowerCase().includes(q))
        : automations;
    // Same filter, for the building blocks (reusable Steps) listed below
    // the automations.
    const visibleSteps = q
        ? steps.filter(s => (s.title || '').toLowerCase().includes(q))
        : steps;

    // The sidebar's plus button: a new automation.
    const onPlus = () => {
        if (!automationsAllowed) return;
        // The in-editor flyout offers this while a building block is
        // open, and an open Step builder outranks the automation pane.
        setBuilderStepId(null);
        setBuilderInitialTab(null);
        setBuilderAutomationId('');
        setPresetChatInput('');
        setAutoSendInput(null);
        setPatternOrigin(null);
        // Fresh mount for a fresh flow — never inherit the previous
        // build's conversation/draft (see newBuilderNonce above).
        setLiveAutomationId(null);
        setNewBuilderNonce(n => n + 1);
    };

    // One row-props builder shared by the persistent sidebar's list AND
    // the in-editor flyout (BFSF-404) — same actions menu (Duplicate /
    // Export JSON / Move to folder / Copy ID / Delete / Activate-Pause)
    // wherever the list is shown. `fromFlyout` only adds the "close the
    // flyout" side effect; every callback is the one the plain list uses.
    // onSelect routes through onPickFromSwitcher (not a bare
    // setBuilderAutomationId) so switching automations from the flyout
    // gets the exact same in-flight-stream guard a Cmd/Ctrl+K jump gets,
    // and so it reliably exits an open Reusable-Step builder too — the
    // flyout, unlike the plain sidebar, can be opened while builderStepId
    // is set, and BuilderShell's `stepBuilderOpen` outranks the automation
    // pane unless builderStepId is cleared.
    const makeAutomationRowProps = (a, { fromFlyout = false } = {}) => ({
        automation: a,
        kind: 'automation',
        selected: builderAutomationId === a.id,
        liveRunning: activeRunIds.has(a.id),
        onSelect: () => {
            if (fromFlyout) setListFlyoutOpen(false);
            onPickFromSwitcher({ id: a.id, kind: 'automation' });
        },
        onOpenRuns: () => {
            if (fromFlyout) setListFlyoutOpen(false);
            setBuilderStepId(null);
            setBuilderInitialTab('history');
            setBuilderAutomationId(a.id);
        },
        onToggleActive: () => toggleAutomation(a),
        onDuplicate: () => duplicateAutomation(a),
        onExportJson: () => exportAutomationJson(a),
        onMoveToFolder: () => setMovingAutomation(a),
        onCopyId: () => copyAutomationId(a),
        onDelete: () => requestDeleteAutomation(a),
    });

    // Building blocks (reusable Steps) sit in the same list as the
    // automations, in their own group (owner, 2026-09-28; they had a tab
    // of their own before). Steps have no quick-switcher entry to model
    // on, so this mirrors its shape: clear the other builder's id first
    // so a block reliably takes over the right pane (the flyout can be
    // opened from an automation's builder), then swap in the target. ''
    // is a new one.
    const openBlock = (id, { runs = false } = {}) => {
        setListFlyoutOpen(false);
        setBuilderAutomationId(null);
        setOpeningBuilder(false);
        setBuilderInitialTab(runs ? 'history' : null);
        setBuilderStepId(id);
    };
    const onNewBlock = () => {
        if (!automationsAllowed) return;
        openBlock('');
    };
    // While a building block is open the flyout leads with the blocks,
    // opened: the Step builder needs the Steps list (BFSF-404 #3).
    const editingBlock = builderStepId !== null;
    const blocksGroup = ({ inFlyout = false } = {}) => (
        <BuildingBlocksGroup
            steps={visibleSteps}
            loading={stepsLoading}
            filtering={!!q}
            forceOpen={inFlyout && editingBlock}
            leading={inFlyout && editingBlock}
            selectedId={builderStepId || null}
            onOpen={(id) => openBlock(id)}
            onOpenRuns={(id) => openBlock(id, { runs: true })}
            onDelete={onDeleteStep}
            onCreate={automationsAllowed ? onNewBlock : null}
        />
    );
    // "No automations yet" only without a filter; with one, "No matches"
    // only when the building blocks have none either.
    const listEmptyNote = !automationsLoading && visibleAutomations.length === 0 && (!q || visibleSteps.length === 0) && (
        <div className="text-xs text-[var(--text-tertiary)] p-4 text-center">
            {q ? t('automations.library.noMatches', 'No matches.') : t('automations.library.noAutomations', 'No automations yet.')}
        </div>
    );

    const sidebar = (
        <aside className="w-[264px] flex-shrink-0 border-r border-[var(--border-default)] flex flex-col bg-[var(--bg-primary)]">
            {/* Sidebar header — title + plus, mirrors SkillsStudio */}
            <div className="px-4 py-3 border-b border-[var(--border-default)] flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-[var(--text-primary)]">
                        {t('automations.library.automations', 'Automations')}
                    </span>
                </div>
                <div className="flex items-center gap-0.5">
                    {(
                        <>
                            {/* One hidden input shared by this button and the row
                                menu. Resetting value on every change is what lets
                                the same file be picked twice in a row. */}
                            <input
                                ref={importInputRef}
                                type="file"
                                accept="application/json,.json"
                                className="hidden"
                                onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    e.target.value = '';
                                    importAutomationFile(file);
                                }}
                            />
                            <button
                                onClick={() => importInputRef.current?.click()}
                                title="Import an automation from a JSON export"
                                aria-label="Import an automation"
                                className="p-1 rounded-lg hover:bg-[var(--bg-secondary)] text-[var(--text-tertiary)]"
                            >
                                <Upload size={15} />
                            </button>
                        </>
                    )}
                    {/* A split +: the main part makes an automation (the
                        default, and the Learning Center's anchor), the
                        chevron beside it also offers a building block. */}
                        <CreateMenuButton
                            onCreateAutomation={onPlus}
                            onCreateBlock={automationsAllowed ? onNewBlock : null}
                            tourAnchor="automation-create"
                            testId="sidebar-create"
                        />
                </div>
            </div>

            {/* Search — debounced filter on the visible list. */}
            <div className="px-2 pt-2">
                <div className="relative">
                    <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] pointer-events-none" />
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Filter…"
                        className="w-full bg-[var(--bg-secondary)] border border-transparent focus:border-[var(--border-default)] rounded-md pl-7 pr-10 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none transition"
                    />
                    {/* The quick switcher's chord, inside the field instead
                        of a tip line under it: one row less above the list,
                        and a click opens the switcher too. */}
                    <button
                        type="button"
                        onClick={() => setQuickSwitcherOpen(true)}
                        title={t('automations.library.quickSwitch', 'Quick switch')}
                        aria-label={t('automations.library.quickSwitch', 'Quick switch')}
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition"
                    >
                        <kbd className="block px-1 rounded border border-[var(--border-default)] font-sans text-[10px] leading-4">{'⌘K'}</kbd>
                    </button>
                </div>
            </div>

            {/* List body */}
            <div className="flex-1 overflow-y-auto p-1.5 mt-1">
                    <>
                        {automationsLoading && automations.length === 0 && (
                            <div className="text-xs text-[var(--text-tertiary)] p-3">Loading…</div>
                        )}
                        {listEmptyNote}
                        <FolderedAutomationList
                            automations={visibleAutomations}
                            folders={folders}
                            filtering={!!q}
                            onCreateFolder={createFolder}
                            onRenameFolder={renameFolder}
                            onDeleteFolder={deleteFolder}
                            onMoveToFolder={moveToFolder}
                            onRestored={fetchAutomations}
                            rowProps={(a) => makeAutomationRowProps(a)}
                            afterFolders={blocksGroup()}
                        />
                    </>
            </div>
        </aside>
    );

    // Right pane: the start screen, the Automations builder, or a Step builder.
    let rightPane;
    const stepBuilderOpen = builderStepId !== null && automationsAllowed;
    const builderOpen = (builderAutomationId !== null || openingBuilder) && automationsAllowed;
    if (stepBuilderOpen) {
        rightPane = (
            <BuilderShell
                key={'step:' + (builderStepId || 'new')}
                mode="step"
                automationId={builderStepId || null}
                initialTab={viewToTab(initialBuilderView) ?? builderInitialTab}
                initialRunId={initialRunId}
                initialRunStepId={initialRunStepId}
                onBuilderStateChange={pushBuilderState}
                onBack={() => { setBuilderStepId(null); setBuilderInitialTab(null); }}
                onOpenList={() => setListFlyoutOpen(true)}
                onAutomationIdResolved={(id) => { if (id) setBuilderStepId(id); }}
                onPublished={() => { fetchSteps(); }}
                user={user}
            />
        );
    } else if (builderOpen) {
        rightPane = (
            <BuilderShell
                // `key` forces a fresh mount when the user switches
                // between automations in the sidebar — without it the
                // builder reuses internal state from the previously-
                // opened automation, which made the second click look
                // like a no-op. New builds key on a per-open nonce so
                // a second Plus never inherits the previous flow's
                // chat/draft (builderAutomationId stays '' for a new
                // build's whole life).
                key={builderAutomationId || `new:${newBuilderNonce}`}
                automationId={builderAutomationId || null}
                initialTab={viewToTab(initialBuilderView) ?? builderInitialTab}
                initialRunId={initialRunId}
                initialRunStepId={initialRunStepId}
                initialAppRef={activeAppRef}
                onBuilderStateChange={pushBuilderState}
                onBack={() => { setBuilderAutomationId(null); setBuilderInitialTab(null); setOpeningBuilder(false); setPresetChatInput(''); setAutoSendInput(null); setPatternOrigin(null); }}
                onOpenList={() => setListFlyoutOpen(true)}
                // Carry the lazily-created id up so the URL/refresh path
                // can reopen a brand-new automation. Never changes the
                // BuilderShell `key`, so it doesn't remount mid-build.
                onAutomationIdResolved={setLiveAutomationId}
                // Flowlet (layer) scope ↔ URL. initialFlowletKey restores
                // the drilled-into flowlet on refresh/back; onScopeChange
                // pushes the scope into the path as the user navigates.
                initialScopeKey={initialFlowletKey}
                onScopeChange={handleScopeChange}
                user={user}
                initialChatInput={presetChatInput}
                autoSendInput={autoSendInput}
                // Only a new build can be the one a pattern opened.
                patternOrigin={builderAutomationId ? null : patternOrigin}
            />
        );
    } else {
        const onPickTemplate = async (templateId) => {
            try {
                const r = await automationApi.getTemplate(templateId);
                const tmpl = r?.template;
                if (!tmpl) return;
                const created = await automationApi.createAutomation({
                    title: tmpl.title,
                    description: tmpl.description || null,
                    definition: tmpl.definition || {},
                    // v1 then reads "Created from template <title>" in Versions.
                    templateId: tmpl.id || templateId,
                });
                await fetchAutomations();
                const newId = created?.automation?.id || created?.id;
                if (newId) {
                    setBuilderInitialTab(null); // a template opens on the Editor
                    setBuilderAutomationId(newId);
                }
            } catch (err) {
                console.warn('[AITasksDesigner] template pick failed:', err.message);
                toast.error(`Could not load template: ${err.message}`);
            }
        };
        rightPane = (
            <AutomationsLauncher
                onCreateAutomation={() => { setBuilderAutomationId(''); setPresetChatInput(''); setAutoSendInput(null); setPatternOrigin(null); }}
                onOpenAutomation={(id) => { setBuilderAutomationId(id); }}
                onPickTemplate={onPickTemplate}
                // "Build this" — open a fresh builder and auto-fire the spec: the
                // pattern's draft trigger and steps, rhythm and template
                // (patternMessage.ts), so the builder has full context.
                onBuildSuggestion={(s) => { setPresetChatInput(''); setAutoSendInput(buildMessageFromPattern(s)); setPatternOrigin(patternOriginOf(s)); setBuilderAutomationId(''); }}
                // "Adjust first" — prefill the same spec so the user can edit before sending.
                onAskSuggestion={(s) => { setAutoSendInput(null); setPresetChatInput(buildMessageFromPattern(s)); setPatternOrigin(patternOriginOf(s)); setBuilderAutomationId(''); }}
                // "New building block", beside "New automation" in the
                // overview's split button.
                onCreateStep={automationsAllowed ? onNewBlock : null}
                // "New folder" — folders organize the overview too
                // (folder pills + board lanes), so making one belongs
                // in its New menu as well (BFSF-478).
                onCreateFolder={automationsAllowed ? createFolder : null}
                // All automations tab — the same rows, filter and
                // per-row actions the sidebar draws, in list / cards /
                // board form.
                automations={visibleAutomations}
                automationsQuery={q}
                automationsLoading={automationsLoading}
                folders={folders}
                activeRunIds={activeRunIds}
                automationRowProps={(a) => makeAutomationRowProps(a)}
                canCreateAutomation={automationsAllowed}
            />
        );
    }

    // Confirm-delete for an automation: it moves to the trash, runs kept.
    const deleteAutomationModal = (
        <DeleteToTrashDialog
            automation={pendingDeleteAutomation}
            onConfirm={confirmDeleteAutomation}
            onCancel={() => setPendingDeleteAutomation(null)}
        />
    );

    return (
        <div
            className="flex h-full bg-[var(--bg-primary)]"
            /* Declares that this surface owns Cmd/Ctrl+K while it is on
               screen. StudioRail binds the same chord in the CAPTURE phase
               and stops it there, which silently made this quick switcher
               unreachable on /app/studio/automations — and Studio's search
               does not list what is inside an open automation, so the chord
               stopped answering the question the person standing here was
               asking. The rail now looks for this attribute and stays out
               of the way; its search is still one click away on the rail
               itself. See StudioRail.jsx's own note. */
            data-quick-open-owner="automations"
        >
            {/* Sidebar collapses while the BuilderShell is in fullscreen
                chrome-collapse mode so the user can use every pixel for
                the diagram. They get back via the back arrow inside the
                builder header. */}
            {!automationEditing && sidebar}
            <section className="flex-1 min-w-0 overflow-hidden">
                {rightPane}
            </section>
            {/* BFSF-404: the sidebar above is gone from the tree the moment
                a builder is open — this is the in-editor way back to the
                list + its per-item actions menu (Activate/Duplicate/Export
                JSON/Move to folder/Rename/Delete), reached via the list
                icon BuilderHeader renders next to "Back to Automations". A
                fixed slide-over rather than reusing the collapsed column so
                it can sit ABOVE the fullscreen canvas and any open NDV
                (z-[1000]) / mapping-picker (z-[1200]) panel; below
                QuickSwitcher's z-[2000] should the two ever be open at once.
                A left-placement Modal: Escape and the scrim close it, Tab
                stays in it. The surface is an inner div, so its corners
                stay square. */}
            <Modal
                open={automationEditing && listFlyoutOpen}
                onClose={() => setListFlyoutOpen(false)}
                placement="left"
                variant="bare"
                size="auto"
                zIndex={1500}
                initialFocus={flyoutFilterRef}
                label={t('automations.library.automations', 'Automations')}
                className="max-w-[300px]"
            >
                <div className="flex-1 min-h-0 flex flex-col border-r border-[var(--border-default)] bg-[var(--bg-primary)] shadow-2xl">
                    <div className="px-4 py-3 border-b border-[var(--border-default)] flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-[var(--text-primary)]">
                                {t('automations.library.automations', 'Automations')}
                            </span>
                        </div>
                        <div className="flex items-center gap-0.5">
                            {/* The sidebar's split +, also while a building
                                block is open: automations stay the default. */}
                            <CreateMenuButton
                                onCreateAutomation={() => { setListFlyoutOpen(false); onPlus(); }}
                                onCreateBlock={automationsAllowed ? onNewBlock : null}
                                testId="flyout-create"
                            />
                            <button
                                onClick={() => setListFlyoutOpen(false)}
                                title="Close"
                                aria-label="Close"
                                className="p-1 rounded-lg hover:bg-[var(--bg-secondary)] text-[var(--text-tertiary)]"
                            >
                                <X size={16} />
                            </button>
                        </div>
                    </div>

                    <div className="px-2 pt-2">
                        <div className="relative">
                            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] pointer-events-none" />
                            <input
                                ref={flyoutFilterRef}
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Filter…"
                                className="w-full bg-[var(--bg-secondary)] border border-transparent focus:border-[var(--border-default)] rounded-md pl-7 pr-2 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none transition"
                            />
                        </div>
                    </div>

                    {/* The same list as the sidebar: automations, folders,
                        then the building blocks. With a building block
                        open, the blocks lead (see editingBlock above). */}
                    <div className="flex-1 overflow-y-auto p-1.5 mt-1">
                        {editingBlock && blocksGroup({ inFlyout: true })}
                        {automationsLoading && automations.length === 0 && (
                            <div className="text-xs text-[var(--text-tertiary)] p-3">Loading…</div>
                        )}
                        {listEmptyNote}
                        <FolderedAutomationList
                            automations={visibleAutomations}
                            folders={folders}
                            filtering={!!q}
                            onCreateFolder={createFolder}
                            onRenameFolder={renameFolder}
                            onDeleteFolder={deleteFolder}
                            onMoveToFolder={moveToFolder}
                            onRestored={fetchAutomations}
                            rowProps={(a) => makeAutomationRowProps(a, { fromFlyout: true })}
                            afterFolders={editingBlock ? null : blocksGroup({ inFlyout: true })}
                        />
                    </div>
                </div>
            </Modal>
            <QuickSwitcher
                open={quickSwitcherOpen}
                items={quickSwitcherItems}
                onPick={onPickFromSwitcher}
                onClose={() => setQuickSwitcherOpen(false)}
            />
            <MoveToFolderDialog
                automation={movingAutomation}
                folders={folders}
                onPick={(folderId) => { moveToFolder(movingAutomation.id, folderId); setMovingAutomation(null); }}
                onClose={() => setMovingAutomation(null)}
            />
            {deleteAutomationModal}
            {confirmDialog}
        </div>
    );
}
