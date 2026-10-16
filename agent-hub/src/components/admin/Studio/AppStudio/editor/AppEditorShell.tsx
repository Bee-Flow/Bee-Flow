import { DndContext, DragOverlay } from '@dnd-kit/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import CanvasJs from './Canvas';
import canvasCollision from './collision';
import { DropHintContext as DropHintContextJs } from './dropHint';
import type { DropHint } from './dropHint';
import { EditorChromeContext as EditorChromeContextJs } from './EditorChromeContext';
import { BuildCueContext as BuildCueContextJs } from './BuildCueContext';
import { ScreenValuesContext as ScreenValuesContextJs, useScreenValuesStore } from './ScreenValuesContext';
import EditorHeader, { PANEL_VIEWS } from './EditorHeader';
import type { HeaderApp, HeaderView } from './header/headerModel';
import { CHAT, ChatColumn, DragChip, INSPECTOR, InspectorColumn, useSidePane } from './shell/ShellPanes';
import { useChromeHandles } from './shell/useChromeHandles';
import type { BuildCue } from './shell/useChromeHandles';
import { useCanvasDrag } from './shell/useCanvasDrag';
import type { ActiveDrag } from './shell/useCanvasDrag';
import { useEditorSave } from './shell/useEditorSave';
import useEditorHotkeysJs from './useEditorHotkeys';
import CanvasPlanPanelJs from '../../../../automation/Builder/CanvasPlanPanel';
import InspectorPanelJs from '../inspector/InspectorPanel';
import { readPresenter, writePresenter } from '../../../../shared/builder/presenterFlag';
import useDraftHistory from '../../../../../hooks/useDraftHistory';
import type { UseDraftHistoryReturn } from '../../../../../hooks/useDraftHistory';
import useTranslation from '../../../../../hooks/useTranslation';
import scopedStorage from '../../../../../utils/scopedStorage';
import type { AppDefinition } from '../inspector/appDefinition';
import { AppEditorProvider } from '../state/AppEditorContext';
import { useAppEditorState } from '../state/appEditorState';
import './editor.css';

/**
 * App Studio editor — the shell that owns the editing data flow.
 *
 * Props (contract — a sibling module imports this):
 *   { app, onClose, onAppUpdated?, chatSlot? }
 *
 * Composition:
 *   - AppEditorProvider seeds the reducer store from `app`.
 *   - useDraftHistory owns undo/redo; commitDefinition (= history.commit) is
 *     THE single entry point every edit goes through — header, tabs, palette,
 *     canvas, inspector and hotkeys all receive it as onCommit.
 *   - useEditorSave (useAppAutosave) debounces saves of the draft; conflicts
 *     surface as a dialog in the header (load latest vs overwrite — never
 *     auto-retried).
 *   - One DndContext for palette→canvas and canvas↔canvas drags
 *     (shell/useCanvasDrag). The DragOverlay is always a compact chip (icon +
 *     label), never the live component.
 *
 * Layout: LEFT chatSlot (collapsible + resizable, hidden-not-unmounted so a
 * streaming AI turn survives a collapse; a slim Sparkles rail when collapsed
 * or absent) · CENTER header/tabs/canvas · RIGHT InspectorPanel
 * (edit mode only — preview gives the app the full width).
 */
export interface AppEditorShellProps {
    app: HeaderApp;
    onClose?: () => void;
    onAppUpdated?: (app: HeaderApp) => void;
    chatSlot?: ReactNode;
}

// Typed views of .jsx/.js siblings whose defaults would mistype their props.
const Canvas = CanvasJs as unknown as ComponentType<{ app: HeaderApp; onCommit: (def: AppDefinition) => void; editActionState: Record<string, unknown> }>;
const CanvasPlanPanel = CanvasPlanPanelJs;
// inspector/InspectorPanel.tsx is TypeScript now; the alias keeps the compiled text.
const InspectorPanel = InspectorPanelJs;
const useEditorHotkeys = useEditorHotkeysJs;

// The context modules are TypeScript now; the aliases keep the compiled text.
const ScreenValuesContext = ScreenValuesContextJs;
const EditorChromeContext = EditorChromeContextJs;
const BuildCueContext = BuildCueContextJs;
const DropHintContext = DropHintContextJs;

export default function AppEditorShell({ app, onClose, onAppUpdated, chatSlot }: AppEditorShellProps) {
    return (
        <AppEditorProvider app={app}>
            <EditorChrome app={app} onClose={onClose} onAppUpdated={onAppUpdated} chatSlot={chatSlot} />
        </AppEditorProvider>
    );
}

function EditorChrome({ app, onClose, onAppUpdated, chatSlot }: AppEditorShellProps) {
    const { definition, version, screenId, mode, streamLock, dispatch } = useAppEditorState();
    const { t } = useTranslation();

    // Refs for event handlers that must never read a stale render (drag
    // events and async saves fire between renders, after effects).
    const definitionRef = useRef(definition);
    const screenIdRef = useRef(screenId);
    useEffect(() => {
        definitionRef.current = definition;
        screenIdRef.current = screenId;
    });

    // ---- history (undo/redo) ----------------------------------------------
    const apply = useCallback(
        (def: AppDefinition | null) => dispatch({ type: 'set_definition', definition: def }),
        [dispatch],
    );
    const history = useDraftHistory({ currentDraft: definition, apply });
    const commitDefinition = history.commit;

    // Set for the whole duration of a drag (it also drives the DragOverlay chip
    // below); declared up here because autosave has to see it.
    const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
    // Where the drag would land, so the canvas can draw a line there. Without
    // it a reorder inside one container showed nothing at all until you let go.
    const [dropHint, setDropHint] = useState<DropHint | null>(null);

    // Paused during an AI turn: the builder route persists every draft itself,
    // so autosaving mid-stream would double-write (and race the version).
    // BuilderChatPane calls markSaved with the final draft. Paused during a
    // drag as well: onDragOver applies cross-parent reparents TRANSIENTLY, and
    // a drag that outlives the debounce — or one the user cancels — must never
    // be what gets persisted. finishDrag restores the snapshot before the
    // pause lifts, so the save that follows is of the committed result.
    const save = useEditorSave({
        appId: app?.id, definition, version, enabled: !!app?.id && !streamLock && !activeDrag,
        dispatch, definitionRef, resetHistory: history.reset, t,
    });

    // ---- command palette (⌘K) ----------------------------------------------
    const [commandOpen, setCommandOpen] = useState(false);

    // ---- which view the header segments have open ---------------------------
    // 'edit' | 'preview' | 'data' | 'logic' | 'roles'. The header owns the
    // segmented control and reports through onViewChange; the shell only uses
    // it to hide the canvas (the views render from the header, above it) and
    // the inspector while one of PANEL_VIEWS fills the column.
    const [editorView, setEditorView] = useState<HeaderView>('edit');

    // ---- presenter mode ----------------------------------------------------
    // Shift+P, shared flag with the automation canvas (shared/builder/presenterFlag):
    // larger banner/ghost/activity type, nothing else — on a DOM grid the cards
    // are the app's own components and are not scaled.
    const [presenter, setPresenter] = useState(readPresenter);
    const togglePresenter = useCallback(() => {
        setPresenter((on: boolean) => { writePresenter(!on); return !on; });
    }, []);

    // ---- hotkeys ------------------------------------------------------------
    useEditorHotkeys({
        enabled: true,
        onUndo: history.undo,
        onRedo: history.redo,
        onFlush: save.flush,
        onCommit: commitDefinition,
        onCommandPalette: useCallback(() => setCommandOpen((o) => !o), []),
        onTogglePresenter: togglePresenter,
    });

    const drag = useCanvasDrag({ t, dispatch, definitionRef, screenIdRef, commitDefinition, streamLock, setActiveDrag, setDropHint });

    // ---- chat pane width / collapse ------------------------------------------
    // Same treatment the inspector already had: on a 1366px laptop the fixed
    // 340px pane plus the inspector left the canvas ~700px — collapsing either
    // side is the difference between building and squinting. The pane is
    // HIDDEN, never unmounted: BuilderChatPane holds the conversation and a
    // possibly-streaming AI turn, and collapsing the column must lose neither.
    const chatPane = useSidePane(CHAT);
    const { chrome, buildCue } = useChromeHandles({
        chatPane, commitTurn: drag.commitTurn, markSaved: save.markSaved, flush: save.flush, appId: app?.id ?? null, undo: history.undo,
    });

    const inspectorPane = useSidePane(INSPECTOR);

    // ---- the live values on the canvas, readable from the inspector ---------
    // "Test with what is on screen" lives in the inspector; the values live in
    // the canvas. Ref-backed and stable, so publishing on every keystroke costs
    // no render here — see ScreenValuesContext.js.
    const screenValues = useScreenValuesStore();

    // ---- inspector test-action results feed the edit canvas ------------------
    const [testActionState, setTestActionState] = useState<Record<string, unknown>>({});
    const onTestActionResult = useCallback((actionId: string | null, entry: unknown) => {
        if (!actionId) return;
        setTestActionState((prev) => ({ ...prev, [actionId]: entry }));
    }, []);

    return (
        <EditorChromeContext.Provider value={chrome}>
        <ScreenValuesContext.Provider value={screenValues}>
        <div
            className="ase-shell flex h-full min-h-0 w-full"
            style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
            data-presenter={presenter ? 'on' : undefined}
        >
            <ChatColumn chatSlot={chatSlot} pane={chatPane} streamLock={streamLock} />

            <EditorCenter
                app={app} onAppUpdated={onAppUpdated} onClose={onClose} history={history} commitDefinition={commitDefinition}
                save={save} commandOpen={commandOpen} setCommandOpen={setCommandOpen} editorView={editorView} setEditorView={setEditorView}
                buildCue={buildCue} dropHint={dropHint} drag={drag} activeDrag={activeDrag} testActionState={testActionState}
            />

            {/* RIGHT — inspector (edit mode only; preview gets the full width) */}
            {mode === 'edit' && editorView === 'edit'
                ? (
                    <InspectorColumn pane={inspectorPane}>
                        <InspectorPanel onCommit={commitDefinition} onTestActionResult={onTestActionResult} />
                    </InspectorColumn>
                )
                : null}
        </div>
        </ScreenValuesContext.Provider>
        </EditorChromeContext.Provider>
    );
}

interface EditorCenterProps {
    app: HeaderApp;
    onAppUpdated?: (app: HeaderApp) => void;
    onClose?: () => void;
    history: UseDraftHistoryReturn<AppDefinition | null>;
    commitDefinition: (def: AppDefinition) => void;
    save: ReturnType<typeof useEditorSave>;
    commandOpen: boolean;
    setCommandOpen: (open: boolean) => void;
    editorView: HeaderView;
    setEditorView: (view: HeaderView) => void;
    buildCue: BuildCue | null;
    dropHint: DropHint | null;
    drag: ReturnType<typeof useCanvasDrag>;
    activeDrag: ActiveDrag | null;
    testActionState: Record<string, unknown>;
}

/** CENTER — the header, the canvas (or the view that replaces it) and the drag overlay. */
function EditorCenter({
    app, onAppUpdated, onClose, history, commitDefinition, save, commandOpen, setCommandOpen, editorView, setEditorView,
    buildCue, dropHint, drag, activeDrag, testActionState,
}: EditorCenterProps) {
    const { t } = useTranslation();
    // Header + tabs + canvas share the DndContext with the palette.
    // overflow-x-clip: whatever the header/tabs/ribbon do at extreme widths,
    // they may never paint across the column boundary into the inspector
    // again (clip, not hidden — no scroll container, and the vertical axis
    // stays visible for the tab menus and save notices).
    return (
        <div className="flex min-w-0 flex-1 flex-col min-h-0 overflow-x-clip">
            <BuildCueContext.Provider value={buildCue}>
            <DropHintContext.Provider value={dropHint}>
            <DndContext
                sensors={drag.sensors}
                collisionDetection={canvasCollision}
                onDragStart={drag.handleDragStart}
                onDragOver={drag.handleDragOver}
                onDragEnd={(event) => drag.finishDrag(event, false)}
                onDragCancel={(event) => drag.finishDrag(event, true)}
            >
                <EditorHeader
                    app={app}
                    onAppUpdated={onAppUpdated}
                    onClose={onClose}
                    onCommit={commitDefinition}
                    canUndo={history.canUndo}
                    canRedo={history.canRedo}
                    onUndo={history.undo}
                    onRedo={history.redo}
                    saveStatus={save.saveStatus}
                    saveError={save.saveError}
                    saveNotices={save.saveNotices}
                    onFlush={save.flush}
                    conflict={save.conflict}
                    onConflictLoadLatest={save.onConflictLoadLatest}
                    onConflictOverwrite={save.onConflictOverwrite}
                    onConflictDismiss={() => save.setConflict(null)}
                    onServerDefinition={save.onServerDefinition}
                    commandOpen={commandOpen}
                    onCommandOpenChange={setCommandOpen}
                    onViewChange={setEditorView}
                />
                {(PANEL_VIEWS as readonly string[]).includes(editorView) ? null : (
                    <div className="relative flex min-h-0 flex-1 flex-col">
                        {/* The AI's own checklist, on the canvas rather than
                            in the conversation (owner, 2026-09-16) — the
                            build is here, and in the chat it scrolled away
                            under the messages it was describing. */}
                        {Array.isArray(buildCue?.todos) && buildCue.todos.length > 0 ? (
                            <CanvasPlanPanel todos={buildCue.todos} running={!!buildCue.running} t={t} idPrefix="app" placement="bottom-left" />
                        ) : null}
                        <Canvas app={app} onCommit={commitDefinition} editActionState={testActionState} />
                    </div>
                )}
                <DragOverlay dropAnimation={null}>
                    {activeDrag ? <DragChip label={activeDrag.label} Icon={activeDrag.Icon} /> : null}
                </DragOverlay>
            </DndContext>
            </DropHintContext.Provider>
            </BuildCueContext.Provider>
        </div>
    );
}
