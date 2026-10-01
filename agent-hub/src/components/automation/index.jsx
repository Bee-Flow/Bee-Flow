import { Bot, Plus, Play, Pause, X, ArrowLeft, Search, Upload } from 'lucide-react';
import React, { useState, useEffect, useCallback, useId, useMemo, useRef } from 'react';
import { API_BASE, authFetch } from '../../utils/helpers';
import MarkdownRenderer from '../renderers/MarkdownRenderer';
import BuilderShell from './Builder/BuilderShell';
import { describeCron } from './Builder/flow/scheduleBuilderUtils';
import EditorView from './EditorView';
import ListView from './ListView';
import { buildMessageFromSuggestion } from './taskFormatters';
import useAutomationLibrary from './useAutomationLibrary';
import usePromptTasks from './usePromptTasks';
import useRoutineRouting from './useRoutineRouting';
import { useTranslation } from '../../hooks/useTranslation';
import { releaseStudioChrome } from '../../hooks/useStudioChrome';
import BuildingBlocksGroup from '../admin/Studio/RoutinesStudio/BuildingBlocksGroup';
import CreateMenuButton from '../admin/Studio/RoutinesStudio/CreateMenuButton';
import DeleteToTrashDialog from '../admin/Studio/RoutinesStudio/DeleteToTrashDialog';
import FolderedRoutineList, { MoveToFolderDialog } from '../admin/Studio/RoutinesStudio/FolderedRoutineList';
import QuickSwitcher from '../admin/Studio/RoutinesStudio/QuickSwitcher';
import RoutineRow from '../admin/Studio/RoutinesStudio/RoutineRow';
import RoutinesLauncher from '../admin/Studio/RoutinesStudio/RoutinesLauncher';
import { buildStudioSearch, parseAppRefParam, stickyFrom } from '../admin/Studio/studioRoutes';
import { useEntitlements } from '../licensing/EntitlementsContext';
import Modal from '../shared/Modal';
import { toast } from '../shared/Toast';
import useConfirm from '../shared/useConfirm';

export default function AITasksDesigner({ initialTaskId = null, initialStepId = null, initialFlowletKey = null, initialBuilderView = null, initialRunId = null, initialRunStepId = null, initialFrom = null, onClose, onNavigate, modelTiers = {}, embedded = false, user = null, onEditingChange }) {
    const { confirm, confirmDialog } = useConfirm();
    const { t } = useTranslation();
    // Unified entitlements snapshot — replaces the legacy user?.betaFeatures
    // reads so the UI matches the server's requireCapability gating exactly
    // (super-admins are granted every beta by the resolver itself).
    const ent = useEntitlements();
    const routinesAllowed = !ent.loading && ent.can('agent_routines');
    const {
        tasks, loading, maxTasks, agents,
        resultModal, setResultModal,
        pendingDeleteTask, setPendingDeleteTask,
        editingTaskId,
        title, setTitle,
        prompt, setPrompt,
        date, setDate,
        time, setTime,
        repeatInterval, setRepeatInterval,
        tier, setTier,
        agentId, setAgentId,
        activeTasks, inactiveTasks, editing, isNewMode, canSave, nextRunPreview,
        fetchTasks, resetForm, startNewTask, startEditTask, saveTask, toggleTask,
        requestDeleteTask, confirmDeleteTask, runTaskNow, openInDirectChat,
    } = usePromptTasks({ routinesAllowed });

    // Sub-tab: prompt tasks (legacy) or automations (new conversational builder)
    const [subTab, setSubTab] = useState('prompt'); // 'prompt' | 'automations' (kept for back-compat with legacy non-embedded view)
    const [segment, setSegment] = useState('automation'); // 'automation' | 'prompt_task' — controls which list shows in the unified sidebar
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
    const [movingRoutine, setMovingRoutine] = useState(null);
    const importInputRef = useRef(null);
    const [presetChatInput, setPresetChatInput] = useState(''); // seeded from EmptyState examples
    const [autoSendInput, setAutoSendInput] = useState(null); // "Build it directly" — auto-fire this spec in a fresh builder
    // Reusable Steps (kind='block') — own builder + own list. Always available
    // wherever automations are (no separate feature flag).
    const [builderStepId, setBuilderStepId] = useState(null); // null=list · ''=new · id=editing
    const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
    // BFSF-404: the persistent sidebar is removed from the tree (not just
    // collapsed) the moment a builder is open — this flyout is the only
    // in-editor way back to the list + its per-item actions menu.
    const [listFlyoutOpen, setListFlyoutOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    // One id base for the headings the dialogs below are labelled by.
    const dialogIds = useId();
    // The flyout's filter takes the focus when it opens (Modal's initialFocus),
    // not the first control, the "+" button.
    const flyoutFilterRef = useRef(null);
    // Signal upward (Studio → AgentHub) when the BuilderShell is open so the
    // outer chrome can collapse for a fullscreen edit, mirroring AgentStudio.
    const automationEditing = ((embedded && segment === 'automation') || subTab === 'automations') && (builderAutomationId !== null || openingBuilder || builderStepId !== null);
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
        setBuilderAutomationId, setBuilderInitialTab, setBuilderStepId, setOpeningBuilder, setSegment,
    });


    // The id of the routine/automation currently open in the editor. Drives the
    // URL path so a refresh (or browser back/forward) reopens it. For automations
    // the builder id wins; a brand-new draft falls back to the id BuilderShell
    // reports once it lazily creates the row. For prompt tasks it's the task being
    // edited (never the 'new' sentinel — that has no persistable id yet).
    const selectedRoutineId =
        segment === 'automation'
            ? (builderAutomationId || liveAutomationId || null)
            : (editingTaskId && editingTaskId !== 'new' ? editingTaskId : null);

    // ── ?from=app:… — the button this builder was opened from ──────────────
    // The rule itself lives beside the `?from=` contract in studioRoutes.js —
    // it is about what the token means, not about this component.
    const fromRef = useRef({ routineId: initialTaskId || null, token: initialFrom || null });
    fromRef.current = stickyFrom(fromRef.current, selectedRoutineId);
    const activeFromToken = fromRef.current.token;
    const activeAppRef = useMemo(() => parseAppRefParam(activeFromToken), [activeFromToken]);

    // Editing-signal: only the Automations builder requests fullscreen chrome
    // collapse. Editing a regular routine keeps the Studio top-tabs visible
    // so users don't lose their place — routines is a section inside Studio,
    // not a separate screen.
    const taskEditing = subTab === 'prompt' && editingTaskId !== null;
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

    // Snap sub-tab back to 'prompt' when the user loses access to the
    // Automations beta. Replaces the old `setTimeout(setSubTab, 0)` in
    // render which was a setState-in-render anti-pattern.
    const automationsAllowed = !ent.loading && ent.can('automations');
    useEffect(() => {
        // Don't snap on the pre-load snapshot — a deep-link into Automations
        // would be bounced to 'prompt' before entitlements resolve.
        if (ent.loading) return;
        if (subTab === 'automations' && !automationsAllowed) {
            setSubTab('prompt');
        }
    }, [subTab, automationsAllowed, ent.loading]);

    const { handleScopeChange, pushBuilderState, stepUrlAdoptedRef } = useRoutineRouting({
        initialTaskId, initialFlowletKey, initialStepId, embedded, onNavigate,
        automations, tasks, selectedRoutineId, builderAutomationId, liveAutomationId,
        builderStepId, editingTaskId, activeFromToken,
        setSegment, setBuilderAutomationId, setBuilderStepId, setOpeningBuilder, setLiveAutomationId,
        startNewTask, startEditTask, resetForm,
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

    const quickSwitcherItems = useMemo(() => {
        const a = automations.map(it => ({
            id: it.id,
            kind: 'automation',
            kindLabel: 'Automation',
            title: it.title || 'Untitled automation',
            // Readable, not raw: `0 9 * * *` in a quick-switcher subtitle
            // helps nobody pick the right routine.
            subtitle: it.triggerType + (it.scheduleCron ? ` · ${describeCron(it.scheduleCron)}` : ''),
        }));
        const t = tasks.map(it => ({
            id: it.id,
            kind: 'prompt_task',
            kindLabel: 'Routine',
            title: it.title || 'Untitled routine',
            subtitle: it.repeatInterval || 'one-time',
        }));
        return [...a, ...t];
    }, [automations, tasks]);

    const onPickFromSwitcher = useCallback((item) => {
        setQuickSwitcherOpen(false);
        // Jumping to another routine leaves the previous one's builder state
        // (open run, forced tab, an open Step builder) behind — carrying any
        // of it across reads as the new routine misbehaving.
        setBuilderInitialTab(null);
        setBuilderStepId(null);
        stepUrlAdoptedRef.current = true;
        if (item.kind === 'automation') {
            setSegment('automation');
            setBuilderAutomationId(item.id);
        } else {
            setSegment('prompt_task');
            const task = tasks.find(t => t.id === item.id);
            if (task) startEditTask(task);
        }
    }, [tasks]);

    // The overlays below go through the shared Modal: Escape and a press on
    // the backdrop close them (the backdrop did before), Tab stays inside and
    // focus returns to what opened them. z-values are the ones they had.
    const deleteModal = pendingDeleteTask && (
        <Modal
            open
            onClose={() => setPendingDeleteTask(null)}
            variant="bare"
            size="md"
            zIndex={1000}
            labelledBy={`${dialogIds}-delete-task`}
            className="bg-[var(--bg-primary)] shadow-xl border border-[var(--border-default)]"
        >
            <div className="flex items-start justify-between px-5 py-4 border-b border-[var(--border-default)]">
                <div id={`${dialogIds}-delete-task`} className="text-sm font-semibold text-[var(--text-primary)]">Delete routine</div>
                <button onClick={() => setPendingDeleteTask(null)} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                    <X size={18} />
                </button>
            </div>
            <div className="px-5 py-4 text-sm text-[var(--text-secondary)]">
                Delete "<strong>{pendingDeleteTask.title}</strong>"? This cannot be undone.
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border-default)]">
                <button
                    onClick={() => setPendingDeleteTask(null)}
                    className="px-4 py-2 rounded-full text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]"
                >
                    Cancel
                </button>
                <button
                    onClick={confirmDeleteTask}
                    className="px-4 py-2 rounded-full text-sm bg-red-500 text-white hover:bg-red-600"
                >
                    Delete
                </button>
            </div>
        </Modal>
    );

    const resultModalEl = resultModal && (
        <Modal
            open
            onClose={() => setResultModal(null)}
            variant="bare"
            size="auto"
            zIndex={2000}
            labelledBy={`${dialogIds}-result`}
            className="max-w-[720px]"
        >
            <div
                style={{
                    width: '100%', maxWidth: 720, maxHeight: '85vh',
                    background: 'var(--bg-card, #ffffff)', borderRadius: 20,
                    boxShadow: '0 25px 80px rgba(0,0,0,0.25), 0 8px 24px rgba(0,0,0,0.12)',
                    display: 'flex', flexDirection: 'column', overflow: 'hidden',
                    animation: 'aiTaskResultIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
                    border: '1px solid var(--border-subtle, rgba(0,0,0,0.06))',
                }}
            >
                <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '16px 20px',
                    borderBottom: '1px solid var(--border-subtle, rgba(0,0,0,0.06))',
                    background: 'var(--bg-secondary)',
                }}>
                    <div style={{
                        width: 36, height: 36, borderRadius: 10,
                        background: 'var(--bg-secondary)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        border: '1px solid var(--border-default)', flexShrink: 0,
                    }}>
                        <Bot style={{ width: 18, height: 18, color: 'var(--text-primary)' }} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div id={`${dialogIds}-result`} style={{
                            fontSize: 15, fontWeight: 700, color: 'var(--text-primary, #0f172a)',
                            lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{resultModal.title}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted, #94a3b8)', fontWeight: 500, marginTop: 2 }}>
                            Routine result
                        </div>
                    </div>
                    <button
                        onClick={() => openInDirectChat(resultModal.title, resultModal.content)}
                        style={{
                            display: 'flex', alignItems: 'center', gap: 6,
                            padding: '8px 14px', borderRadius: 10,
                            fontSize: 13, fontWeight: 600,
                            border: 'none', cursor: 'pointer',
                            background: 'var(--text-primary)',
                            color: '#fff', boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                            flexShrink: 0,
                        }}
                    >
                        💬 Discuss in Chat
                    </button>
                    <button
                        onClick={() => setResultModal(null)}
                        style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            padding: 6, borderRadius: 8,
                            color: 'var(--text-muted, #94a3b8)', flexShrink: 0,
                        }}
                    >
                        <X style={{ width: 18, height: 18 }} />
                    </button>
                </div>
                <div style={{
                    flex: 1, overflowY: 'auto',
                    padding: '20px 24px',
                    fontSize: 14, lineHeight: 1.7,
                    color: 'var(--text-primary, #0f172a)',
                }}>
                    <MarkdownRenderer content={resultModal.content} />
                </div>
            </div>
        </Modal>
    );

    const styles = (
        <style>{`
            @keyframes aiTaskFadeIn {
                from { opacity: 0; transform: translateY(4px); }
                to { opacity: 1; transform: translateY(0); }
            }
            @keyframes aiTaskSpin { to { transform: rotate(360deg); } }
            @keyframes aiTaskResultBgIn { from { opacity: 0; } to { opacity: 1; } }
            @keyframes aiTaskResultIn {
                from { opacity: 0; transform: translateY(12px) scale(0.96); }
                to { opacity: 1; transform: translateY(0) scale(1); }
            }
        `}</style>
    );

    // ── Embedded studio layout (the redesigned sidebar+detail shell) ─────
    if (embedded) {
        // The tab is Automations; there is no segment to pick any more. The
        // 'prompt_task' value survives as an internal route only — deep-linking
        // an agent routine (from the agent that owns it) still opens its editor
        // here, which is the one place that editor exists.
        const effectiveSegment = segment;

        // Filter the active list by the search query (case-insensitive
        // match on title; cheap enough to do every render). Power-user
        // search is also via Cmd/Ctrl+K — this input is the discoverable
        // route for everyone else.
        const q = searchQuery.trim().toLowerCase();
        const visibleAutomations = q
            ? automations.filter(a => (a.title || '').toLowerCase().includes(q))
            : automations;
        const visibleTasks = q
            ? tasks.filter(t => (t.title || '').toLowerCase().includes(q))
            : tasks;
        // Same filter, for the building blocks (reusable Steps) listed below
        // the automations.
        const visibleSteps = q
            ? steps.filter(s => (s.title || '').toLowerCase().includes(q))
            : steps;

        // The sidebar's plus button creates the right thing per segment.
        const onPlus = () => {
            if (effectiveSegment === 'automation') {
                if (!automationsAllowed) return;
                // The in-editor flyout offers this while a building block is
                // open, and an open Step builder outranks the automation pane.
                setBuilderStepId(null);
                setBuilderInitialTab(null);
                setBuilderAutomationId('');
                setPresetChatInput('');
                setAutoSendInput(null);
                // Fresh mount for a fresh flow — never inherit the previous
                // build's conversation/draft (see newBuilderNonce above).
                setLiveAutomationId(null);
                setNewBuilderNonce(n => n + 1);
            } else {
                startNewTask();
            }
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
            routine: a,
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
            onMoveToFolder: () => setMovingRoutine(a),
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
                {q ? t('routines.library.noMatches', 'No matches.') : t('routines.library.noAutomations', 'No automations yet.')}
            </div>
        );

        const sidebar = (
            <aside className="w-[264px] flex-shrink-0 border-r border-[var(--border-default)] flex flex-col bg-[var(--bg-primary)]">
                {/* Sidebar header — title + plus, mirrors SkillsStudio */}
                <div className="px-4 py-3 border-b border-[var(--border-default)] flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-[var(--text-primary)]">
                            {effectiveSegment === 'automation' ? t('routines.library.automations', 'Automations') : 'Agent routines'}
                        </span>
                    </div>
                    <div className="flex items-center gap-0.5">
                        {effectiveSegment === 'automation' && (
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
                        {effectiveSegment === 'automation' ? (
                            <CreateMenuButton
                                onCreateAutomation={onPlus}
                                onCreateBlock={automationsAllowed ? onNewBlock : null}
                                tourAnchor="routine-create"
                                testId="sidebar-create"
                            />
                        ) : (
                            <button
                                onClick={onPlus}
                                data-tour="routine-create"
                                title="New agent routine"
                                className="p-1 rounded-lg hover:bg-[var(--bg-secondary)] text-[var(--text-tertiary)]"
                            >
                                <Plus size={16} />
                            </button>
                        )}
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
                            title={t('routines.library.quickSwitch', 'Quick switch')}
                            aria-label={t('routines.library.quickSwitch', 'Quick switch')}
                            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition"
                        >
                            <kbd className="block px-1 rounded border border-[var(--border-default)] font-sans text-[10px] leading-4">{'⌘K'}</kbd>
                        </button>
                    </div>
                </div>

                {/* List body */}
                <div className="flex-1 overflow-y-auto p-1.5 mt-1">
                    {effectiveSegment === 'automation' ? (
                        <>
                            {automationsLoading && automations.length === 0 && (
                                <div className="text-xs text-[var(--text-tertiary)] p-3">Loading…</div>
                            )}
                            {listEmptyNote}
                            <FolderedRoutineList
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
                    ) : (
                        <>
                            {/* Plain prompt tasks moved to Cowork — one sidebar
                                click, with an editor and a run history. What is
                                left in this segment is the agent-linked kind,
                                which runs through the agent runtime. */}
                            {onNavigate && (
                            <button
                                type="button"
                                onClick={() => onNavigate('cowork')}
                                data-testid="routines-cowork-pointer"
                                className="mx-2 mb-2 w-[calc(100%-1rem)] text-left rounded-lg px-2.5 py-2 text-[11px] leading-snug transition-colors hover:bg-[var(--bg-tertiary)]"
                                style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
                            >
                                <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>Looking for your prompt tasks?</span>
                                <br />
                                They live under Cowork now →
                            </button>
                            )}
                            {loading && tasks.length === 0 && (
                                <div className="text-xs text-[var(--text-tertiary)] p-3">Loading…</div>
                            )}
                            {!loading && visibleTasks.length === 0 && (
                                <div className="text-xs text-[var(--text-tertiary)] p-4 text-center">
                                    {q ? 'No matches.' : 'No agent routines yet. An agent gets one from its own editor.'}
                                </div>
                            )}
                            {visibleTasks.map((t) => (
                                <RoutineRow
                                    key={t.id}
                                    routine={t}
                                    kind="prompt_task"
                                    selected={editingTaskId === t.id}
                                    onSelect={() => startEditTask(t)}
                                    onDelete={() => requestDeleteTask(t)}
                                />
                            ))}
                        </>
                    )}
                </div>
            </aside>
        );

        // Right pane: empty state, Automations builder, or Prompt Task editor.
        let rightPane;
        if (effectiveSegment === 'automation') {
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
                        onBack={() => { setBuilderAutomationId(null); setBuilderInitialTab(null); setOpeningBuilder(false); setPresetChatInput(''); setAutoSendInput(null); }}
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
                            setSegment('automation');
                            setBuilderAutomationId(newId);
                        }
                    } catch (err) {
                        console.warn('[AITasksDesigner] template pick failed:', err.message);
                        toast.error(`Could not load template: ${err.message}`);
                    }
                };
                rightPane = (
                    <RoutinesLauncher
                        segment="automation"
                        onCreateAutomation={() => { setBuilderAutomationId(''); setPresetChatInput(''); setAutoSendInput(null); }}
                        onOpenAutomation={(id) => { setBuilderAutomationId(id); }}
                        onPickTemplate={onPickTemplate}
                        // "Build it directly" — open a fresh builder and auto-fire the spec,
                        // grounded with the scan's observed evidence so the builder has full context.
                        onBuildSuggestion={(s) => { setPresetChatInput(''); setAutoSendInput(buildMessageFromSuggestion(s)); setBuilderAutomationId(''); }}
                        // "Ask for changes" — prefill the grounded spec so the user can edit before sending.
                        onAskSuggestion={(s) => { setAutoSendInput(null); setPresetChatInput(buildMessageFromSuggestion(s)); setBuilderAutomationId(''); }}
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
        } else {
            const currentTask = editingTaskId && editingTaskId !== 'new'
                ? tasks.find(t => t.id === editingTaskId) || null
                : null;
            if (!editing) {
                rightPane = (
                    <RoutinesLauncher
                        segment="prompt_task"
                        onCreateTask={startNewTask}
                    />
                );
            } else {
                rightPane = (
                    <div className="overflow-y-auto h-full">
                        {/* Task action bar for existing tasks (kept from previous design — quick run/pause/result). */}
                        {currentTask && (
                            <div className="flex items-center gap-2 px-6 pt-5 pb-1 flex-wrap">
                                <button
                                    onClick={() => runTaskNow(currentTask.id)}
                                    disabled={currentTask.lastStatus === 'running'}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold disabled:opacity-50"
                                    style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                                >
                                    <Play size={12} /> Run Now
                                </button>
                                <button
                                    onClick={() => toggleTask(currentTask.id)}
                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold"
                                    style={{
                                        background: currentTask.isActive ? 'rgba(245,158,11,0.08)' : 'rgba(34,197,94,0.08)',
                                        color: currentTask.isActive ? '#f59e0b' : '#22c55e',
                                    }}
                                >
                                    {currentTask.isActive ? <><Pause size={12} /> Pause</> : <><Play size={12} /> Resume</>}
                                </button>
                                {currentTask.lastResult && (
                                    <button
                                        onClick={() => setResultModal({ title: currentTask.title, content: currentTask.lastResult })}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold"
                                        style={{ background: 'rgba(34,197,94,0.08)', color: '#22c55e' }}
                                    >
                                        View last result ↗
                                    </button>
                                )}
                            </div>
                        )}
                        <EditorView
                            title={title} setTitle={setTitle}
                            prompt={prompt} setPrompt={setPrompt}
                            date={date} setDate={setDate}
                            time={time} setTime={setTime}
                            repeatInterval={repeatInterval} setRepeatInterval={setRepeatInterval}
                            tier={tier} setTier={setTier}
                            modelTiers={modelTiers}
                            agentId={agentId} setAgentId={setAgentId}
                            agents={agents} routinesAllowed={routinesAllowed}
                            canSave={canSave} isNewMode={isNewMode}
                            onSave={saveTask} onCancel={resetForm}
                            nextRunPreview={nextRunPreview}
                        />
                    </div>
                );
            }
        }

        // Confirm-delete for an automation: it moves to the trash, runs kept.
        const deleteAutomationModal = (
            <DeleteToTrashDialog
                routine={pendingDeleteAutomation}
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
                   does not list what is inside an open routine, so the chord
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
                    icon BuilderHeader renders next to "Back to Routines". A
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
                    label={t('routines.library.automations', 'Automations')}
                    className="max-w-[300px]"
                >
                    <div className="flex-1 min-h-0 flex flex-col border-r border-[var(--border-default)] bg-[var(--bg-primary)] shadow-2xl">
                        <div className="px-4 py-3 border-b border-[var(--border-default)] flex items-center justify-between">
                            <div className="flex items-center gap-2">
                                <span className="text-sm font-semibold text-[var(--text-primary)]">
                                    {t('routines.library.automations', 'Automations')}
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
                            <FolderedRoutineList
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
                    routine={movingRoutine}
                    folders={folders}
                    onPick={(folderId) => { moveToFolder(movingRoutine.id, folderId); setMovingRoutine(null); }}
                    onClose={() => setMovingRoutine(null)}
                />
                {deleteModal}
                {deleteAutomationModal}
                {resultModalEl}
                {styles}
                {confirmDialog}
            </div>
        );
    }

    // ── Legacy standalone layout ─────────────────────────────────────────────
    return (
        <div className="flex-1 flex flex-col h-full bg-[var(--bg-primary)] overflow-hidden">
            {/* Header */}
            <div className="flex items-center gap-3 px-6 h-14 border-b border-[var(--border-subtle)] bg-[var(--bg-card)] flex-shrink-0">
                {editing && (
                    <button
                        onClick={resetForm}
                        className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                        title="Back to list"
                    >
                        <ArrowLeft className="w-4 h-4" />
                    </button>
                )}
                <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-default)' }}>
                    <Bot className="w-[18px] h-[18px]" style={{ color: 'var(--text-primary)' }} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="text-[15px] font-bold text-[var(--text-primary)] leading-tight">
                        {editing ? (isNewMode ? 'New agent routine' : 'Edit agent routine') : 'Agent routines'}
                    </div>
                    <div className="text-[11px] text-[var(--text-muted)] font-medium">
                        {editing ? 'Schedule a recurring AI workflow' : `${tasks.length}/${maxTasks} tasks`}
                    </div>
                </div>
                {!editing && (
                    <button
                        onClick={startNewTask}
                        disabled={tasks.length >= maxTasks}
                        className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-semibold text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                        style={{ background: 'var(--text-primary)', boxShadow: tasks.length >= maxTasks ? 'none' : '0 2px 8px rgba(0,0,0,0.1)' }}
                    >
                        <Plus className="w-4 h-4" />
                        New agent routine
                    </button>
                )}
                {onClose && (
                    <button
                        onClick={onClose}
                        className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] ml-1"
                        title="Close"
                    >
                        <X className="w-4 h-4" />
                    </button>
                )}
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto">
                {editing ? (
                    <EditorView
                        title={title} setTitle={setTitle}
                        prompt={prompt} setPrompt={setPrompt}
                        date={date} setDate={setDate}
                        time={time} setTime={setTime}
                        repeatInterval={repeatInterval} setRepeatInterval={setRepeatInterval}
                        tier={tier} setTier={setTier}
                        modelTiers={modelTiers}
                        agentId={agentId} setAgentId={setAgentId}
                        agents={agents} routinesAllowed={routinesAllowed}
                        canSave={canSave} isNewMode={isNewMode}
                        onSave={saveTask} onCancel={resetForm}
                        nextRunPreview={nextRunPreview}
                    />
                ) : (
                    <ListView
                        loading={loading}
                        activeTasks={activeTasks}
                        inactiveTasks={inactiveTasks}
                        modelTiers={modelTiers}
                        onEdit={startEditTask}
                        onToggle={toggleTask}
                        onRequestDelete={requestDeleteTask}
                        onRunNow={runTaskNow}
                        onOpenResult={(data) => setResultModal(data)}
                        onCreate={startNewTask}
                        canCreate={tasks.length < maxTasks}
                    />
                )}
            </div>

            {deleteModal}
            {resultModalEl}
            {styles}
            {confirmDialog}
        </div>
    );
}
