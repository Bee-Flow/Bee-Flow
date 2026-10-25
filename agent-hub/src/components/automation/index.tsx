import React, { useMemo, useRef } from 'react';
import { AutomationFlyout, AutomationSidebar } from './AutomationListPanes';
import BuilderShell from './Builder/BuilderShell';
import { patternOriginOf } from './Builder/usePatternOrigin';
import { buildMessageFromPattern } from './patternMessage';
import useAutomationLibrary from './useAutomationLibrary';
import useAutomationRouting from './useAutomationRouting';
import { useDesignerList } from './useDesignerList';
import { createFromTemplate, useDesignerState, type DesignerState, useQuickSwitcher, useStudioChromeSync } from './useDesignerShell';
import { useTranslation } from '../../hooks/useTranslation';
import FolderedAutomationList, { MoveToFolderDialog } from '../admin/Studio/AutomationsStudio/FolderedAutomationList';
import DeleteToTrashDialog from '../admin/Studio/AutomationsStudio/DeleteToTrashDialog';
import AutomationsLauncher from '../admin/Studio/AutomationsStudio/AutomationsLauncher';
import QuickSwitcher from '../admin/Studio/AutomationsStudio/QuickSwitcher';
import { parseAppRefParam, stickyFrom } from '../admin/Studio/studioRoutes';
import { useEntitlements } from '../licensing/EntitlementsContext';
import useConfirm from '../shared/useConfirm';
import type { AutomationLibrary, AutomationListRow } from './useAutomationLibrary';
import type { BuilderTab } from './Builder/useBuilderTabUrl';
import type { AutomationRouting } from './useAutomationRouting';
import type { AppUserLike } from '../projects/workspace/types';
import type { AutomationRowProps } from '../admin/Studio/AutomationsStudio/AutomationRow';
import type { AppRef } from '../admin/Studio/AppStudio/inspector/appDefinition';
import { RepeatingSuggestion } from '../../api/queries/automation/repeating';


/** The list the sidebar and the flyout share: loading note, empty note, folders and rows. */
interface AutomationListSectionProps {
    library: AutomationLibrary;
    visibleAutomations: AutomationListRow[];
    visibleStepCount: number;
    filtering: boolean;
    leading?: React.JSX.Element | null;
    afterFolders?: React.JSX.Element | null;
    rowProps: (a: AutomationListRow) => AutomationRowProps;
}

function AutomationListSection({ library, visibleAutomations, visibleStepCount, filtering, rowProps, leading = null, afterFolders = null }: AutomationListSectionProps) {
    const { t } = useTranslation();
    const { automations, folders, automationsLoading } = library;
    // "No automations yet" only without a filter; with one, "No matches"
    // only when the building blocks have none either.
    const emptyNote = !automationsLoading && visibleAutomations.length === 0 && (!filtering || visibleStepCount === 0) && (
        <div className="text-xs text-[var(--text-tertiary)] p-4 text-center">
            {filtering ? t('automations.library.noMatches', 'No matches.') : t('automations.library.noAutomations', 'No automations yet.')}
        </div>
    );
    return (
        <>
            {leading}
            {automationsLoading && automations.length === 0 && (
                <div className="text-xs text-[var(--text-tertiary)] p-3">{t('automations.automation_page.loading', 'Loading…')}</div>
            )}
            {emptyNote}
            <FolderedAutomationList
                automations={visibleAutomations}
                folders={folders}
                filtering={filtering}
                onCreateFolder={library.createFolder}
                onMoveFolder={library.moveFolder}
                onRenameFolder={library.renameFolder}
                onDeleteFolder={library.deleteFolder}
                onMoveToFolder={library.moveToFolder}
                onRestored={library.fetchAutomations}
                rowProps={rowProps}
                afterFolders={afterFolders}
            />
        </>
    );
}

/** URL ?view= word → builder tab id. The id stays 'history' (BFSF-343); only the URL and the labels say "runs". */
const viewToTab = (view: string | null): BuilderTab | null => (view === 'runs' ? 'history' : (view === 'settings' || view === 'versions' ? view : null));

/**
 * Right pane: the start screen, the Automations builder, or a Step builder. */
interface DesignerRightPaneProps {
    library: AutomationLibrary;
    routing: AutomationRouting;
    automationsAllowed: boolean;
    selectedAutomationId: string | null;
    activeAppRef: AppRef | null;
    initialBuilderView: string | null;
    visibleAutomations: AutomationListRow[];
    query: string;
    designer: DesignerState;
    initialRunId: string | null;
    initialRunStepId: string | null;
    initialFlowletKey: string | null;
    user: AppUserLike | null;
    rowProps: (a: AutomationListRow) => AutomationRowProps;
}

function DesignerRightPane({
    designer: d, library, routing, automationsAllowed, selectedAutomationId, activeAppRef, initialBuilderView,
    initialRunId, initialRunStepId, initialFlowletKey, user, visibleAutomations, query, rowProps,
}: DesignerRightPaneProps) {
    const onNewBlock = automationsAllowed ? d.onNewBlock : null;
    const stepBuilderOpen = d.builderStepId !== null && automationsAllowed;
    const builderOpen = (d.builderAutomationId !== null || d.openingBuilder) && automationsAllowed;
    const initialTab = viewToTab(initialBuilderView) ?? (d.builderInitialTab as BuilderTab | null);
    if (stepBuilderOpen) {
        return (
            <BuilderShell
                key={'step:' + (d.builderStepId || 'new')}
                mode="step"
                automationId={d.builderStepId || null}
                initialTab={initialTab}
                initialRunId={initialRunId}
                initialRunStepId={initialRunStepId}
                onBuilderStateChange={routing.pushBuilderState}
                onBack={() => { d.setBuilderStepId(null); d.setBuilderInitialTab(null); }}
                onOpenList={() => d.setListFlyoutOpen(true)}
                onAutomationIdResolved={(id) => { if (id) d.setBuilderStepId(id); }}
                onPublished={() => { library.fetchSteps(); }}
                user={user}
            />
        );
    }
    if (builderOpen) {
        return (
            <BuilderShell
                // `key` forces a fresh mount when the user switches
                // between automations in the sidebar — without it the
                // builder reuses internal state from the previously-
                // opened automation, which made the second click look
                // like a no-op. New builds key on a per-open nonce so
                // a second Plus never inherits the previous flow's
                // chat/draft (builderAutomationId stays '' for a new
                // build's whole life).
                key={d.builderAutomationId || `new:${d.newBuilderNonce}`}
                automationId={d.builderAutomationId || null}
                initialTab={initialTab}
                initialRunId={initialRunId}
                initialRunStepId={initialRunStepId}
                initialAppRef={activeAppRef}
                onBuilderStateChange={routing.pushBuilderState}
                onBack={() => {
                    d.setBuilderAutomationId(null); d.setBuilderInitialTab(null); d.setOpeningBuilder(false);
                    d.setPresetChatInput(''); d.setAutoSendInput(null); d.setPatternOrigin(null);
                }}
                onOpenList={() => d.setListFlyoutOpen(true)}
                // Workflow-level action inside the editor (BFSF-405); only a
                // persisted automation can be exported.
                onExportJson={selectedAutomationId
                    ? () => library.exportAutomationJson(
                        library.automations.find(a => a.id === selectedAutomationId) || { id: selectedAutomationId, title: '' },
                    )
                    : undefined}
                // Carry the lazily-created id up so the URL/refresh path
                // can reopen a brand-new automation. Never changes the
                // BuilderShell `key`, so it doesn't remount mid-build.
                onAutomationIdResolved={d.setLiveAutomationId}
                // Flowlet (layer) scope ↔ URL. initialFlowletKey restores
                // the drilled-into flowlet on refresh/back; onScopeChange
                // pushes the scope into the path as the user navigates.
                initialScopeKey={initialFlowletKey}
                onScopeChange={routing.handleScopeChange}
                user={user}
                initialChatInput={d.presetChatInput}
                autoSendInput={d.autoSendInput}
                // Only a new build can be the one a pattern opened.
                patternOrigin={d.builderAutomationId ? null : d.patternOrigin}
            />
        );
    }
    return (
        <AutomationsLauncher
            onCreateAutomation={() => { d.setBuilderAutomationId(''); d.setPresetChatInput(''); d.setAutoSendInput(null); d.setPatternOrigin(null); }}
            onOpenAutomation={(id) => { d.setBuilderAutomationId(id); }}
            onPickTemplate={(templateId: string) => createFromTemplate(templateId, {
                automationApi: library.automationApi,
                fetchAutomations: library.fetchAutomations,
                open: (newId) => {
                    d.setBuilderInitialTab(null); // a template opens on the Editor
                    d.setBuilderAutomationId(newId);
                },
            })}
            // "Build this" — open a fresh builder and auto-fire the spec: the
            // pattern's draft trigger and steps, rhythm and template
            // (patternMessage.ts), so the builder has full context.
            onBuildSuggestion={(s: RepeatingSuggestion|null|undefined) => {
                d.setPresetChatInput(''); d.setAutoSendInput(buildMessageFromPattern(s)); d.setPatternOrigin(patternOriginOf(s)); d.setBuilderAutomationId('');
            }}
            // "Adjust first" — prefill the same spec so the user can edit before sending.
            onAskSuggestion={(s: RepeatingSuggestion|null|undefined) => {
                d.setAutoSendInput(null); d.setPresetChatInput(buildMessageFromPattern(s)); d.setPatternOrigin(patternOriginOf(s)); d.setBuilderAutomationId('');
            }}
            // "New building block", beside "New automation" in the
            // overview's split button.
            onCreateStep={onNewBlock}
            // "New folder" — folders organize the overview too
            // (folder pills + board lanes), so making one belongs
            // in its New menu as well (BFSF-478).
            onCreateFolder={automationsAllowed ? library.createFolder : null}
            // All automations tab — the same rows, filter and
            // per-row actions the sidebar draws, in list / cards /
            // board form.
            automations={visibleAutomations}
            automationsQuery={query}
            automationsLoading={library.automationsLoading}
            folders={library.folders}
            activeRunIds={library.activeRunIds}
            automationRowProps={rowProps}
            canCreateAutomation={automationsAllowed}
        />
    );
}

interface AITasksDesignerProps {
    initialTaskId?: string | null;
    initialStepId?: string | null;
    initialFlowletKey?: string | null;
    initialBuilderView?: string | null;
    initialRunId?: string | null;
    initialRunStepId?: string | null;
    initialFrom?: string | null;
    onNavigate?: ((path: string, opts?: { replace?: boolean }) => void) | null;
    user?: AppUserLike | null;
    embedded?: boolean;
    onEditingChange?: (editing: boolean) => void;
}

export default function AITasksDesigner({ initialTaskId = null, initialStepId = null, initialFlowletKey = null, initialBuilderView = null, initialRunId = null, initialRunStepId = null, initialFrom = null, onNavigate, embedded = false, user = null, onEditingChange }: AITasksDesignerProps) {
    const { confirm, confirmDialog } = useConfirm();
    // Unified entitlements snapshot — replaces the legacy user?.betaFeatures
    // reads so the UI matches the server's requireCapability gating exactly
    // (super-admins are granted every beta by the resolver itself).
    const ent = useEntitlements();
    const automationsAllowed = !ent.loading && ent.can('automations');
    const designer = useDesignerState(automationsAllowed);
    const {
        builderAutomationId, setBuilderAutomationId, setBuilderInitialTab, openingBuilder, setOpeningBuilder,
        liveAutomationId, setLiveAutomationId, movingAutomation, setMovingAutomation, builderStepId, setBuilderStepId,
        listFlyoutOpen, setListFlyoutOpen, searchQuery, setSearchQuery, flyoutFilterRef, automationEditing, onPlus, onNewBlock,
    } = designer;
    const library = useAutomationLibrary({
        confirm, builderAutomationId, openingBuilder, builderStepId,
        setBuilderAutomationId, setBuilderInitialTab, setBuilderStepId, setOpeningBuilder,
    });
    const { automations, folders, moveToFolder } = library;

    // The id of the automation currently open in the editor. Drives the
    // URL path so a refresh (or browser back/forward) reopens it. The builder
    // id wins; a brand-new draft falls back to the id BuilderShell reports once
    // it lazily creates the row.
    const selectedAutomationId = builderAutomationId || liveAutomationId || null;

    // ── ?from=app:… — the button this builder was opened from ──────────────
    // The rule itself lives beside the `?from=` contract in studioRoutes.js —
    // it is about what the token means, not about this component.
    const fromRef = useRef({ automationId: initialTaskId || null, token: initialFrom || null });
    fromRef.current = stickyFrom(fromRef.current, selectedAutomationId) as { automationId: string | null; token: string | null };
    const activeFromToken = fromRef.current.token;
    const activeAppRef = useMemo(() => parseAppRefParam(activeFromToken), [activeFromToken]);

    // Editing-signal: only the Automations builder requests fullscreen chrome
    // collapse. Editing a regular automation keeps the Studio top-tabs visible
    // so users don't lose their place — automations is a section inside Studio,
    // not a separate screen.
    useStudioChromeSync(automationEditing, onEditingChange, setListFlyoutOpen);

    const routing = useAutomationRouting({
        initialTaskId, initialFlowletKey, initialStepId, embedded, onNavigate,
        automations, selectedAutomationId, builderAutomationId, liveAutomationId,
        builderStepId, activeFromToken,
        setBuilderAutomationId, setBuilderStepId, setOpeningBuilder, setLiveAutomationId,
    });

    const { quickSwitcherOpen, setQuickSwitcherOpen, quickSwitcherItems, onPickFromSwitcher } = useQuickSwitcher({
        embedded, automations, setBuilderInitialTab, setBuilderStepId, setBuilderAutomationId,
        stepUrlAdoptedRef: routing.stepUrlAdoptedRef,
    });
    const { q, visibleAutomations, visibleSteps, makeAutomationRowProps, editingBlock, blocksGroup } = useDesignerList({
        designer, library, automationsAllowed, onPickFromSwitcher,
    });
    const listSectionProps = { library, visibleAutomations, visibleStepCount: visibleSteps.length, filtering: !!q };
    const onNewBlockIfAllowed = automationsAllowed ? onNewBlock : null;

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
            {!automationEditing && (
                <AutomationSidebar
                    importAutomationFile={library.importAutomationFile}
                    searchQuery={searchQuery}
                    setSearchQuery={setSearchQuery}
                    onOpenQuickSwitcher={() => setQuickSwitcherOpen(true)}
                    onPlus={onPlus}
                    onNewBlock={onNewBlockIfAllowed}
                >
                    <AutomationListSection
                        {...listSectionProps}
                        rowProps={(a: AutomationListRow) => makeAutomationRowProps(a)}
                        afterFolders={blocksGroup()}
                    />
                </AutomationSidebar>
            )}
            <section className="flex-1 min-w-0 overflow-hidden">
                <DesignerRightPane
                    designer={designer}
                    library={library}
                    routing={routing}
                    automationsAllowed={automationsAllowed}
                    selectedAutomationId={selectedAutomationId}
                    activeAppRef={activeAppRef}
                    initialBuilderView={initialBuilderView}
                    initialRunId={initialRunId}
                    initialRunStepId={initialRunStepId}
                    initialFlowletKey={initialFlowletKey}
                    user={user}
                    visibleAutomations={visibleAutomations}
                    query={q}
                    rowProps={(a: AutomationListRow) => makeAutomationRowProps(a)}
                />
            </section>
            {/* BFSF-404: the sidebar above is gone from the tree the moment
                a builder is open — this is the in-editor way back to the
                list + its per-item actions menu, reached via the list icon
                BuilderHeader renders next to "Back to Automations". */}
            <AutomationFlyout
                open={automationEditing && listFlyoutOpen}
                onClose={() => setListFlyoutOpen(false)}
                filterRef={flyoutFilterRef}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                onPlus={onPlus}
                onNewBlock={onNewBlockIfAllowed}
            >
                {/* With a building block open, the blocks lead the list, opened. */}
                <AutomationListSection
                    {...listSectionProps}
                    rowProps={(a: AutomationListRow) => makeAutomationRowProps(a, { fromFlyout: true })}
                    leading={editingBlock ? blocksGroup({ inFlyout: true }) : null}
                    afterFolders={editingBlock ? null : blocksGroup({ inFlyout: true })}
                />
            </AutomationFlyout>
            <QuickSwitcher
                open={quickSwitcherOpen}
                items={quickSwitcherItems}
                onPick={onPickFromSwitcher}
                onClose={() => setQuickSwitcherOpen(false)}
            />
            <MoveToFolderDialog
                automation={movingAutomation}
                folders={folders}
                onPick={(folderId: string|null) => { moveToFolder((movingAutomation as NonNullable<typeof movingAutomation>).id, folderId); setMovingAutomation(null); }}
                onClose={() => setMovingAutomation(null)}
            />
            {/* Confirm-delete for an automation: it moves to the trash, runs kept. */}
            <DeleteToTrashDialog
                automation={library.pendingDeleteAutomation}
                onConfirm={library.confirmDeleteAutomation}
                onCancel={() => library.setPendingDeleteAutomation(null)}
            />
            {confirmDialog}
        </div>
    );
}
