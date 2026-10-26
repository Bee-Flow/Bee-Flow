import { useMemo, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import useAutomationTitlesJs from './automationTitles';
import nodeLogicSummaryJs from './nodeLogicSummary';
import { LogicMarks, LogicPill, MultiToolbar, NodeToolbar, ResizeGrips } from './nodeWrapper/NodeOverlays';
import { SPAN_INERT_PARENTS, claimPointerDown, findNode, pillFor, selectionRoots } from './nodeWrapper/nodeWrapperModel';
import type { LogicMark } from './nodeWrapper/nodeWrapperModel';
import { useCellSortable } from './nodeWrapper/useCellSortable';
import { useNodeResize } from './nodeWrapper/useNodeResize';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AppDefinition, AppNode } from '../inspector/appDefinition';
import { getKnobsForType } from '../inspector/styleKnobMeta';
import { getComponentEntry } from '../runtime/componentRegistry';
import { useRuntime } from '../runtime/RuntimeContext';
import { isFill } from '../runtime/styleResolver.helpers';
import { useAppEditorState } from '../state/appEditorState';
import { duplicateNode, removeNode } from '../state/definitionOps';

/**
 * App Studio editor — the NodeWrapper the canvas hands to AppRenderer.
 *
 * Honors the renderer contract: it renders the node's GRID CELL and spreads
 * className/style onto its outermost element so the 12-column placement
 * survives. Everything editor-y layers on top:
 *
 *   - useSortable(node.id): the whole cell activates a drag (PointerSensor
 *     distance 6 keeps plain clicks selecting), and the selected node's
 *     mini-toolbar exposes an explicit GripVertical activator. We do NOT
 *     apply sortable transforms — live move feedback comes from the shell's
 *     transient definition updates (see dnd.js header).
 *   - selection on pointerdown (not click, so drags still start); the event is
 *     CLAIMED rather than stopped, so nested nodes don't select their container
 *     too while document-level outside-click handlers still see it.
 *   - ON-CANVAS RESIZE (nodeWrapper/useNodeResize): a selected, unlocked node
 *     gets a right-edge WIDTH grip and, for types whose spec carries the
 *     `height` knob (image), a bottom-edge HEIGHT grip. Both live-preview via
 *     LOCAL inline style only and commit ONE history entry on pointer-up.
 *     Handles are absolute overlays (no layout shift), hidden in preview/run
 *     mode and while the AI streams.
 *   - leaf content is inert in edit mode (React 19 boolean attribute) with a
 *     pointer-events fallback, so inner buttons/inputs are dead. Container
 *     content stays interactive — its children are EditorNodeWrappers
 *     themselves and must remain selectable; runtime components already
 *     no-op their handlers in edit mode.
 *   - hover/selected outlines + the "just added" pulse live in editor.css
 *     (outline/box-shadow/opacity only — no layout shift; selection raises
 *     z-index and relaxes `contain` from layout+paint to layout so the
 *     toolbar and resize grips may overflow the cell).
 */
export interface EditorNodeWrapperProps {
    node: AppNode & { style?: { span?: unknown; height?: unknown; [key: string]: unknown } };
    className?: string;
    style?: CSSProperties;
    children?: ReactNode;
    onCommit?: (def: AppDefinition) => void;
}

// nodeLogicSummary calls titleFor with an action's optional automationId, and
// useLogicMarks' titleFor indexes automationTitles with it. Typing that honestly
// needs a runtime guard (follow-up), so this view still narrows it to string.
const nodeLogicSummary = nodeLogicSummaryJs as unknown as (
    node: AppNode, definition: AppDefinition | null, titleFor: ((id: string) => string | null) | null, t: TranslateFn,
) => LogicMark[];
const useAutomationTitles = useAutomationTitlesJs;

/**
 * What logic this component carries, for the badge strip and the named pill.
 * Only the primary instance draws it — a node inside a repeater is mounted
 * once per row and would otherwise wear the same badges N times.
 *
 * Marks are computed WITHOUT titles first, so the strip and its tooltips
 * never wait on a request; the named pill asks for the automation titles only
 * once a node that actually runs one is selected, and the marks recompute
 * with `titleFor` when they arrive.
 */
function useLogicMarks(node: AppNode, definition: AppDefinition | null, active: boolean, selected: boolean, t: TranslateFn) {
    const baseMarks = useMemo(
        () => (active ? nodeLogicSummary(node, definition, null, t) : []),
        [active, node, definition, t],
    );
    const automationTitles = useAutomationTitles(
        selected && baseMarks.some((m) => m.actionKind === 'run_automation'),
    );
    const logicMarks = useMemo(
        () => (automationTitles && baseMarks.length
            ? nodeLogicSummary(node, definition, (id) => automationTitles[id] || null, t)
            : baseMarks),
        [automationTitles, baseMarks, node, definition, t],
    );
    // The one worded pill beside the selected component — the first thing the
    // component DOES, in words, where the corner strip only had icons.
    const logicPill = useMemo(
        () => (selected ? pillFor(logicMarks.find((m) => m.kind === 'action'), t) : null),
        [selected, logicMarks, t],
    );
    return { logicMarks, logicPill };
}

/**
 * The node actions — one history commit each. Bulk actions work on the ROOTS
 * of the selection only: a marquee drag collects every element whose rect
 * intersects, and a container's rect encloses its children, so a card and the
 * buttons inside it arrive together. Acting on both duplicated the children
 * twice — once inside the copied card, once again as new siblings INSIDE THE
 * ORIGINAL — so the card the author never touched grew extra buttons.
 */
function useNodeActions(node: AppNode, definition: AppDefinition | null, selectionIds: string[], onCommit: EditorNodeWrapperProps['onCommit'], closeConfirm: () => void) {
    const { dispatch } = useAppEditorState();
    const doRemove = () => {
        closeConfirm();
        onCommit?.(removeNode(definition, node.id));
    };
    const doDuplicate = () => {
        const { def, nodeId } = duplicateNode(definition, node.id);
        if (!nodeId) return;
        onCommit?.(def);
        dispatch({ type: 'select_node', nodeId });
    };
    const doBulkRemove = () => {
        closeConfirm();
        let def = definition;
        for (const id of selectionIds) def = removeNode(def, id);
        if (def !== definition && def) onCommit?.(def);
        dispatch({ type: 'clear_selection' });
    };
    const doBulkDuplicate = () => {
        let def = definition;
        const newIds: string[] = [];
        for (const id of selectionIds) {
            const res = duplicateNode(def, id);
            if (res.nodeId) { def = res.def; newIds.push(res.nodeId); }
        }
        if (def !== definition && def) onCommit?.(def);
        if (newIds.length) dispatch({ type: 'select_many', ids: newIds });
    };
    return { doRemove, doDuplicate, doBulkRemove, doBulkDuplicate };
}

export default function EditorNodeWrapper({ node, className, style, children, onCommit }: EditorNodeWrapperProps) {
    const { t } = useTranslation();
    const { definition, mode, streamLock, recentlyAddedIds, revealDelays, dispatch } = useAppEditorState();
    const { selectedNodeId, selectedNodeIds, onSelectNode } = useRuntime();
    const [confirmDelete, setConfirmDelete] = useState(false);

    const { primary, dropEdge, attributes, listeners, setActivatorNodeRef, isDragging, cellRef, setCellRef } = useCellSortable(node);

    const editMode = mode === 'edit';
    // Multi-select: the whole set is the source of truth; selectedNodeId is its
    // anchor. A node is OUTLINED when it's anywhere in the set; only the ANCHOR
    // renders the mini-toolbar + resize grips (a stable single-node surface).
    const selectionSet = selectedNodeIds instanceof Set ? selectedNodeIds : null;
    const inSelection = editMode && (selectionSet ? selectionSet.has(node.id) : selectedNodeId === node.id);
    const selected = editMode && selectedNodeId === node.id && primary;
    const selectionCount = selectionSet ? selectionSet.size : (selectedNodeId ? 1 : 0);
    const isMulti = selectionCount > 1;
    const recent = recentlyAddedIds instanceof Set && recentlyAddedIds.has(node.id);
    // The AI build deals its cards one at a time: this cell's turn, in ms
    // (0 = now, the paste/starter case). Read by editor.css as the animation
    // delay; `both` fill-mode holds the cell invisible in its reserved slot
    // until then.
    const revealDelay = recent && revealDelays instanceof Map ? (revealDelays.get(node.id) || 0) : 0;
    const isContainer = Array.isArray(node.children);
    const hasChildren = isContainer && (node.children?.length || 0) > 0;
    const childCount = node.children?.length || 0;
    const entry = getComponentEntry(node.type);
    const label: string = entry?.label || node.type || '';

    const knobs: string[] = getKnobsForType(node.type);
    // The width grip used to render for EVERY selected node, including types
    // that carry no `span` knob at all (tab, modal) and children of a `pane`,
    // which lays its children out as a flex stack and ignores span by design.
    // The badge counted up to "7 / 12", nothing moved, and the drag still wrote
    // a history entry — a control that lies about what it does. …and some
    // containers lay their children out with FLEX, where the cell's inline
    // gridColumn is ignored — span is inert in that POSITION even for a type
    // that carries the knob.
    const parentLaysOutWithFlex = useMemo(
        () => (editMode ? SPAN_INERT_PARENTS.has(findNode(definition, node.id)?.parent?.type as string) : false),
        [editMode, definition, node.id],
    );
    const showHandles = selected && !streamLock;
    const { logicMarks, logicPill } = useLogicMarks(node, definition, editMode && primary, selected, t);

    const resize = useNodeResize({ nodeId: node.id, nodeStyle: node.style, definition, streamLock, cellRef, onCommit });

    // --- selection / node actions --------------------------------------------
    const { onPointerDown: dndPointerDown, ...restListeners } = listeners || {};
    const select = (e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
        // Shift/⌘/Ctrl-click toggles this node in the multi-selection; a plain
        // click replaces the selection with just this node (legacy behaviour).
        if (e.shiftKey || e.metaKey || e.ctrlKey) dispatch({ type: 'toggle_node', nodeId: node.id });
        else onSelectNode?.(node.id);
    };

    const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
        // NOT stopPropagation: React dispatches from the root container, so
        // stopping there also kills the native event before it reaches the
        // document-level outside-click listeners every menu/popover closes on.
        // The claim gives nested cells the same "my ancestors keep their hands
        // off" guarantee while the event still travels on to the document.
        if (!claimPointerDown(e)) return;
        dndPointerDown?.(e);
        select(e);
    };

    /*
     * Selection from the keyboard.
     *
     * dnd-kit's attributes give every cell role="button" and a tab stop, and
     * its KeyboardSensor listener (carried in restListeners) claims Enter and
     * Space to START A DRAG. So a keyboard user could tab onto a component,
     * press Enter, and begin dragging it — while no key selected anything.
     * Selecting is what Enter means on something announced as a button, so it
     * takes precedence and the drag keeps its own grip.
     */
    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (e.target !== e.currentTarget) return;   // a control inside keeps its own keys
        e.preventDefault();
        e.stopPropagation();
        select(e);
    };

    const selectionIds = selectionRoots(
        definition,
        selectionSet ? [...selectionSet] : (selectedNodeId ? [selectedNodeId] : []),
    );
    const anyContainerSelected = selectionIds.some((id) => {
        const f = findNode(definition, id);
        return !!f && Array.isArray(f.node.children) && f.node.children.length > 0;
    });
    const actions = useNodeActions(node, definition, selectionIds, onCommit, () => setConfirmDelete(false));
    const clearPulse = () => dispatch({ type: 'clear_recent_id', nodeId: node.id });

    return (
        <div
            ref={setCellRef}
            data-node-id={node.id}
            data-app-type={node.type}
            data-selected={inSelection || undefined}
            data-drop-edge={dropEdge || undefined}
            className={`${className} ase-cell ${recent ? 'ase-added-pulse' : ''}`}
            style={{
                ...style,
                ...resize.previewStyle,
                ...(recent ? { '--ase-reveal-delay': `${revealDelay}ms` } as CSSProperties : {}),
                // Relax paint containment for any selected cell so its outline
                // (and the anchor's toolbar/grips) can overflow the cell box —
                // and for a cell showing a DROP EDGE, whose ::after is drawn at
                // negative offsets. `paint` clipped it to the padding box, and
                // .ase-cell has no padding, so the before/after lines were
                // invisible on every unselected cell: which is to say on every
                // real drop target, since the selected one is the one in flight.
                // That is why dropping "only worked on containers" — the inside
                // tint survived (it is inset), the two lines never showed.
                contain: (inSelection || dropEdge) ? 'layout' : 'layout paint',
                zIndex: selected ? 10 : (inSelection ? 5 : style?.zIndex),
                opacity: isDragging ? 0.4 : style?.opacity,
            }}
            onPointerDown={handlePointerDown}
            onAnimationEnd={recent ? clearPulse : undefined}
            {...attributes}
            {...restListeners}
            // After restListeners, so selecting wins over the keyboard drag.
            onKeyDown={handleKeyDown}
        >
            {selected && isMulti ? (
                <MultiToolbar count={selectionCount} onDuplicate={actions.doBulkDuplicate}
                    onDelete={() => (anyContainerSelected ? setConfirmDelete(true) : actions.doBulkRemove())} />
            ) : selected ? (
                <NodeToolbar nodeType={node.type} label={label} setActivatorNodeRef={setActivatorNodeRef} listeners={listeners}
                    onDuplicate={actions.doDuplicate} onDelete={() => (hasChildren ? setConfirmDelete(true) : actions.doRemove())} />
            ) : null}

            {/*
              * The named pill beside the SELECTED component (artboard 1b).
              * Outside the cell on its right — a selected cell relaxes
              * `contain` to `layout`, so it may overflow. aria-hidden: the
              * sr-only sentence of LogicMarks already says the same thing, and
              * in fuller words.
              */}
            {logicPill ? <LogicPill pill={logicPill} /> : null}
            <LogicMarks marks={logicMarks} label={label} />

            <ResizeGrips resize={resize} showWidth={showHandles && knobs.includes('span') && !parentLaysOutWithFlex}
                showHeight={showHandles && knobs.includes('height')} />

            {/*
              * This div exists to host `inert` + pointerEvents for non-container
              * nodes, so it cannot go away. But run mode (DefaultNodeWrapper)
              * has no equivalent, and while it was height-opaque a fill child
              * collapsed here and ONLY here — the editor showed something the
              * running app would never do, in a codebase whose whole premise is
              * "preview == production". Passing height through costs nothing:
              * the cell above already has a definite height in both hosts (a
              * stretched grid row, or a flex item with flex-grow).
              */}
            <div
                className={`min-w-0${isFill(node) ? ' h-full min-h-0' : ''}`}
                inert={editMode && !isContainer ? true : undefined}
                style={editMode && !isContainer ? { pointerEvents: 'none' } : undefined}
            >
                {children}
            </div>

            <ConfirmDialog
                open={confirmDelete}
                title={isMulti
                    ? t('app_studio.canvas.delete_many_title', 'Delete {n} components?', { n: selectionCount })
                    : t('app_studio.canvas.delete_one_title', 'Delete this {label}?', { label: label.toLowerCase() })}
                // The count picks the KEY, never a letter inside the sentence:
                // an `s` bolted on in JavaScript is English grammar no
                // translation can undo.
                description={isMulti
                    ? t('app_studio.canvas.delete_many_desc', 'Some of them are containers — everything nested inside is deleted too. You can undo this.')
                    : (childCount === 1
                        ? t('app_studio.canvas.delete_one_desc', 'It contains {n} component — everything inside is deleted with it.', { n: childCount })
                        : t('app_studio.canvas.delete_one_desc_plural', 'It contains {n} components — everything inside is deleted with it.', { n: childCount }))}
                confirmLabel={t('app_studio.canvas.delete', 'Delete')}
                destructive
                onConfirm={isMulti ? actions.doBulkRemove : actions.doRemove}
                onCancel={() => setConfirmDelete(false)}
            />
        </div>
    );
}
