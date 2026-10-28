import { useDroppable } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { MousePointerClick } from 'lucide-react';
import { RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import BuildBanner from './BuildBanner';
import { useBuildCue } from './BuildCueContext';
import { buildNode, sectionDroppableId } from './dnd';
import GhostCell from './GhostCell';
import { projectGhostCell } from './ghostCellDraft';
import useBuildFollow from './useBuildFollow';
import EditorNodeWrapper from './EditorNodeWrapper';
import Marquee from './Marquee';
import toast from '@/components/shared/Toast';
import AppRenderer from '../runtime/AppRenderer';
import AppShell from '../runtime/AppShell';
import AppFontLoader from '../runtime/AppFontLoader';
import { APP_COMPONENT_TYPES } from '../runtime/componentRegistry';
import { useAppEditor } from '../state/AppEditorContext';
import { findScreen, insertNode } from '../state/definitionOps';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import useTranslation from '@/hooks/useTranslation';
import type { AppNode, AppSection } from '../inspector/appDefinition';
import type { NodeWrapperProps } from '../runtime/AppRenderer.types';
import type { SectionDropZoneProps, CanvasBodyProps } from './Canvas.types';

// The quickest way out of a blank page, straight on the placeholder. They add
// through exactly the same path as click-to-add in the ribbon.
const STARTER_CHIPS = ['heading', 'text', 'button'];

function SectionDropZone({ sectionId, container, onAddStarter, disabled }: SectionDropZoneProps) {
    const { t } = useTranslation();
    const { setNodeRef, isOver } = useDroppable({
        id: sectionDroppableId(sectionId),
        data: { type: 'section', sectionId },
    });
    return createPortal(
        <div
            ref={setNodeRef}
            data-section-dropzone={sectionId}
            className="flex flex-col items-center justify-center gap-3 border border-dashed px-4 py-8 text-sm select-none"
            style={{
                gridColumn: '1 / -1',
                borderRadius: 'var(--app-radius, 8px)',
                borderColor: isOver ? 'var(--editor-accent)' : 'var(--border-default)',
                background: isOver ? 'color-mix(in srgb, var(--editor-accent) 8%, transparent)' : 'transparent',
                color: 'var(--text-tertiary)',
            }}
        >
            <span className="flex items-center gap-2 text-center">
                <MousePointerClick className="w-4 h-4 shrink-0" aria-hidden="true" />
                {t('studio_apps_edit.canvas.drop_hint', 'Drag a component from the strip above — or just click one to drop it here')}
            </span>
            <span className="flex flex-wrap items-center justify-center gap-1.5">
                {STARTER_CHIPS.filter((type) => APP_COMPONENT_TYPES[type]).map((type) => (
                    <button
                        key={type}
                        type="button"
                        disabled={disabled}
                        onClick={() => onAddStarter(sectionId, type)}
                        className="rounded-full border px-2.5 py-1 text-xs font-medium hover:bg-[var(--bg-tertiary)] disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]"
                    >
                        {t('studio_apps_edit.canvas.add_type', 'Add {type}', { type: APP_COMPONENT_TYPES[type]?.label.toLowerCase() })}
                    </button>
                ))}
            </span>
        </div>,
        container,
    );
}

export function CanvasBody({
    appId, onCommit, editActionState, dataState, refresh, onDataState, refreshRef,
    actionState, runAction, vars, setVar, forms, screenParams, registerFormValue,
    onNavigate, confirmDialog,
}: CanvasBodyProps) {
    const {
        definition, screenId, selectedNodeId, selectedNodeIds, mode, streamLock, recentlyAddedIds,
        previewRole, previewUser, dispatch,
    } = useAppEditor();
    const { t } = useTranslation();

    const screen = findScreen(definition, screenId) || definition?.screens?.[0] || null;

    // Mirror the data-scope values up to the action runner hosted in Canvas —
    // same bridge as AppRunPage's RunBody (sequences read them via refs,
    // asynchronously, so the one-commit lag is never observable).
    useEffect(() => { onDataState(dataState); }, [onDataState, dataState]);
    useEffect(() => { refreshRef.current = refresh; }, [refreshRef, refresh]);

    const onSelectNode = useCallback(
        (nodeId: string | null) => dispatch({ type: 'select_node', nodeId }),
        [dispatch],
    );

    // Edit-mode action stub: navigation is useful while building, everything
    // with side effects only explains itself.
    const definitionRef = useRef(definition);
    useEffect(() => {
        definitionRef.current = definition;
    });
    const editRunAction = useCallback((actionId: string|number) => {
        const action = definitionRef.current?.actions?.[actionId];
        if (!action) return;
        if (action.kind === 'navigate' && action.screenId) {
            dispatch({ type: 'set_screen', screenId: action.screenId });
        } else if (action.kind === 'run_automation') {
            toast.info(t('studio_apps_edit.canvas.runs_automation', 'Runs automation when the app is used'));
        }
    }, [dispatch, t]);

    // Stable wrapper component so the renderer never remounts cells.
    const NodeWrapper = useMemo(() => {
        function CanvasNodeWrapper(props: NodeWrapperProps) {
            return <EditorNodeWrapper {...props} onCommit={onCommit} />;
        }
        return CanvasNodeWrapper;
    }, [onCommit]);

    // One SortableContext per screen: every node id in render order.
    const sortableIds = useMemo(() => {
        const ids: string[] = [];
        const walk = (children: AppNode[] | undefined) => {
            for (const child of children || []) {
                ids.push(child.id);
                if (Array.isArray(child.children)) walk(child.children);
            }
        };
        for (const section of screen?.sections || []) walk(section.children);
        return ids;
    }, [screen]);

    // Empty-section drop zones are portaled into the renderer's real
    // <section data-section-id> elements so they align with the grid.
    const surfaceRef = useRef<HTMLDivElement>(null);
    const [sectionEls, setSectionEls] = useState(() => new Map<string | null | undefined, Element>());
    useLayoutEffect(() => {
        if (mode !== 'edit') {
            setSectionEls((prev) => (prev.size ? new Map() : prev));
            return;
        }
        const root = surfaceRef.current;
        if (!root) return;
        const next = new Map<string | null | undefined, Element>();
        for (const el of root.querySelectorAll('[data-section-id]')) {
            next.set(el.getAttribute('data-section-id'), el);
        }
        setSectionEls((prev) => {
            if (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v)) return prev;
            return next;
        });
    }, [definition, screenId, mode]);

    const emptySections = mode === 'edit'
        ? (screen?.sections || []).filter((s: AppSection) => !(s.children || []).length)
        : [];

    // ── The film: what the AI build is doing, from the chat pane's cue ──
    // The banner (bottom-centre, never dimming), the ghost cell where the
    // component being typed will land, and a camera that follows each landing
    // until the person touches the surface.
    const cue = useBuildCue();
    const reducedMotion = useReducedMotion();
    const follow = useBuildFollow({
        surfaceRef,
        reveal: cue?.reveal || null,
        toolDraft: cue?.toolDraft || null,
        lastCall: cue?.lastCall || null,
        definition,
        screenId,
        dispatch,
        enabled: !!(cue && cue.running && mode === 'edit'),
        reducedMotion,
    });
    const ghost = useMemo(
        () => (cue && cue.running && mode === 'edit' ? projectGhostCell(cue.toolDraft, definition, screenId, t) : null),
        [cue, definition, screenId, mode, t],
    );
    const ghostContainer = ghost ? sectionEls.get(ghost.sectionId) : null;

    // Same insert path as the ribbon's click-to-add, aimed at the empty section
    // the placeholder is sitting in.
    const addStarter = useCallback((sectionId: string, type: string) => {
        if (streamLock) return;
        const node = buildNode(type);
        if (!node) return;
        const { def, nodeId } = insertNode(definitionRef.current, { parentId: sectionId, node });
        if (!nodeId) return;
        onCommit?.(def);
        dispatch({ type: 'select_node', nodeId });
        dispatch({ type: 'set_recent_ids', ids: [nodeId] });
    }, [streamLock, onCommit, dispatch]);

    return (
        <div className="relative flex-1 min-h-0">
            {mode === 'edit' ? (
                <div
                    ref={surfaceRef}
                    className="h-full overflow-y-auto px-6 py-6 bg-[var(--bg-secondary)]"
                    // Node cells no longer stop pointer propagation (that also
                    // stopped document-level menu-closing handlers), so filter
                    // out anything that started on a cell — same
                    // `closest('[data-node-id]')` guard the Marquee uses. The
                    // Marquee overlay owns drag-to-select on this same surface;
                    // a plain click that starts and ends here clears everything.
                    onPointerDown={(selectedNodeId || (selectedNodeIds && selectedNodeIds.size))
                        ? (e) => {
                            if ((e.target as Element | null)?.closest?.('[data-node-id]')) return;
                            dispatch({ type: 'clear_selection' });
                        }
                        : undefined}
                >
                    <Marquee surfaceRef={surfaceRef} />
                    <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
                        <AppRenderer
                            definition={definition}
                            screenId={screenId}
                            mode="edit"
                            NodeWrapper={NodeWrapper}
                            onSelectNode={onSelectNode}
                            selectedNodeId={selectedNodeId}
                            selectedNodeIds={selectedNodeIds}
                            recentlyAddedIds={recentlyAddedIds}
                            actionState={editActionState}
                            dataState={dataState}
                            runAction={editRunAction}
                            previewRole={previewRole}
                            currentUser={previewUser}
                            // The inspector — and therefore "Test with what is on
                            // screen" — exists ONLY in edit mode (AppEditorShell: mode === 'edit' && editorView
                            // === 'edit'). Without this prop AppForm publishes nothing here, the ScreenValues store
                            // received nothing in precisely that mode, and EVERY {kind:'field'} parameter dropped out
                            // with the reason "that form is not on the canvas" — about a form that was visibly there.
                            registerFormValue={registerFormValue}
                        />
                    </SortableContext>
                    {emptySections.map((section: AppSection) => {
                        const container = sectionEls.get(section.id);
                        // The ghost takes the empty section's slot while a card is
                        // being typed into it — a drop zone under a ghost would be
                        // two placeholders for one spot.
                        if (ghost && ghostContainer === container) return null;
                        return container
                            ? (
                                <SectionDropZone
                                    key={section.id}
                                    sectionId={section.id as string}
                                    container={container}
                                    onAddStarter={addStarter}
                                    disabled={streamLock}
                                />
                            )
                            : null;
                    })}
                    {ghost && ghostContainer ? <GhostCell draft={ghost} container={ghostContainer} /> : null}
                </div>
            ) : (
                <div className="h-full min-h-0">
                    {/* Preview == production: the same AppShell, with the
                        preview user standing in for the viewer (UserMenu hides
                        when there is none) and no onExit (the "Alle apps" link
                        is a run-view affordance). */}
                    <AppFontLoader definition={definition} />
                    <AppShell
                        definition={definition}
                        screenId={screenId}
                        onNavigate={onNavigate}
                        viewer={previewUser || null}
                        appId={appId}
                    >
                        <AppRenderer
                            definition={definition}
                            screenId={screenId}
                            mode="run"
                            actionState={actionState}
                            dataState={dataState}
                            runAction={runAction}
                            previewRole={previewRole}
                            currentUser={previewUser}
                            vars={vars}
                            setVar={setVar}
                            forms={forms}
                            screenParams={screenParams}
                            registerFormValue={registerFormValue}
                        />
                    </AppShell>
                    {confirmDialog}
                </div>
            )}

            {/* streamLock shield — always mounted. It blocks pointer events on the
                canvas while the AI edits, and NOTHING more: it used to dim the
                whole canvas 55 % under an "AI is editing…" pill, which hid the
                very cards the film is about. What the build is doing is said
                by the banner below. A wheel on the shield scrolls the surface
                (and, through useBuildFollow, yields the camera). */}
            <CanvasBodySection streamLock={streamLock} surfaceRef={surfaceRef} />
            {/* The build banner: live while the AI builds, a frozen farewell for
                a few seconds after. Above the shield, so "Follow the build" works. */}
            {cue ? (
                <div className="pointer-events-none absolute inset-x-0 bottom-3 z-40 flex justify-center px-4">
                    <div className="pointer-events-auto max-w-full">
                        <BuildBanner following={follow.following} onFollow={follow.follow} screen={follow.screen} />
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function CanvasBodySection({ streamLock, surfaceRef }: { streamLock: boolean; surfaceRef: RefObject<HTMLDivElement | null>; }) {
    return <div
        aria-hidden={!streamLock}
        data-stream-lock={streamLock || undefined}
        className={`absolute inset-0 z-30 ${streamLock ? '' : 'pointer-events-none'}`}
        onWheel={streamLock ? (e) => {
            const el = surfaceRef.current;
            if (!el) return;
            el.scrollBy({ top: e.deltaY });
            // The gesture reached the shield, not the surface — tell the
            // surface anyway, so the camera yields to the person.
            el.dispatchEvent(new Event('wheel'));
        } : undefined}
        onPointerDown={streamLock ? () => { surfaceRef.current?.dispatchEvent?.(new Event('pointerdown')); } : undefined} />;
}
