/**
 * What a canvas cell draws on top of the component: the selected node's
 * mini-toolbar (or the multi-selection's), the named logic pill and the
 * logic marks, and the two resize grips.
 */
import { Copy, GripVertical, Trash2, Zap } from 'lucide-react';
import type { DraggableSyntheticListeners } from '@dnd-kit/core';
import { claimPointerDown, LOGIC_MARK_ICONS } from './nodeWrapperModel';
import type { LogicMark, LogicPillSpec } from './nodeWrapperModel';
import type { NodeResize } from './useNodeResize';
import useTranslation from '@/hooks/useTranslation';
import IconButton from '@/components/shared/IconButton';
import { kindColorVar } from '@/components/shared/kindColors';

/** The pill itself — see pillFor for the shape and the artboard it comes from. */
export function LogicPill({ pill }: { pill: LogicPillSpec }) {
    const Icon = pill.Icon;
    return (
        <span
            className="pointer-events-none absolute top-1/2 z-20 inline-flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-[3px] text-[11px] font-semibold"
            style={{
                left: 'calc(100% + 14px)',
                background: 'var(--bg-card)',
                borderColor: pill.color,
                color: pill.color,
            }}
            data-logic-pill={pill.kind}
            aria-hidden="true"
        >
            <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
            {pill.text}
        </span>
    );
}

/**
 * What this component DOES, on the component itself.
 *
 * Always on in edit mode rather than on hover or on selection: the point is
 * to be able to sweep a screen and see where the logic lives without touching
 * anything. Nodes carrying none — most of them — draw nothing, so the marks
 * stay meaningful. The same thing goes to a screen reader, and to anyone who
 * cannot hover a tooltip: one sentence per rule, off-screen, attached to the
 * cell it describes.
 */
export function LogicMarks({ marks, label }: { marks: LogicMark[]; label: string }) {
    const { t } = useTranslation();
    if (!marks.length) return null;
    return (
        <>
            <div className="ase-logic-marks" data-logic-marks={marks.length} aria-hidden="true">
                {marks.map((mark) => {
                    const Icon = LOGIC_MARK_ICONS[mark.kind] || Zap;
                    return (
                        <span key={mark.key} className="ase-logic-mark" title={mark.text}>
                            <Icon className="w-3 h-3" />
                        </span>
                    );
                })}
            </div>
            <span className="sr-only">
                {t('app_studio.canvas.marks_sr', '{label} — {marks}.', {
                    label,
                    marks: marks.map((m) => m.text).join('. '),
                })}
            </span>
        </>
    );
}

const TOOLBAR = 'absolute left-0 bottom-full mb-1 z-20 flex items-center gap-0.5 rounded-md border px-1 py-0.5 shadow-sm whitespace-nowrap';

interface MultiToolbarProps {
    count: number;
    onDuplicate: () => void;
    onDelete: () => void;
}

/** The anchor's toolbar while several nodes are selected. */
export function MultiToolbar({ count, onDuplicate, onDelete }: MultiToolbarProps) {
    const { t } = useTranslation();
    return (
        <div
            className={TOOLBAR}
            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--editor-accent)' }}
            onPointerDown={claimPointerDown}
            data-multi-toolbar="true"
        >
            <span className="px-1.5 text-[10px] font-semibold uppercase tracking-wide select-none text-[var(--editor-accent)]">
                {t('app_studio.canvas.selected_n', '{n} selected', { n: count })}
            </span>
            <IconButton size="sm" ariaLabel={t('app_studio.canvas.duplicate_selected', 'Duplicate selected')} onClick={onDuplicate}>
                <Copy />
            </IconButton>
            <IconButton size="sm" variant="danger" ariaLabel={t('app_studio.canvas.delete_selected', 'Delete selected')} onClick={onDelete}>
                <Trash2 />
            </IconButton>
        </div>
    );
}

interface NodeToolbarProps {
    nodeType: string | undefined;
    label: string;
    setActivatorNodeRef: (el: HTMLElement | null) => void;
    listeners: DraggableSyntheticListeners;
    onDuplicate: () => void;
    onDelete: () => void;
}

/** The selected node's mini-toolbar: its kind, the move grip, duplicate and delete. */
export function NodeToolbar({ nodeType, label, setActivatorNodeRef, listeners, onDuplicate, onDelete }: NodeToolbarProps) {
    const { t } = useTranslation();
    return (
        <div
            className={TOOLBAR}
            style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}
            onPointerDown={claimPointerDown}
        >
            {/* The KICKER (artboard 1b: "KNOP" above the selected button) —
                the component's type in the app kind's own colour, so the
                toolbar names what it acts on. */}
            <span
                className="px-1 text-[10px] font-semibold uppercase tracking-wide select-none"
                style={{ color: kindColorVar('app') }}
                data-node-kicker={nodeType}
            >
                {label}
            </span>
            <button
                type="button"
                ref={setActivatorNodeRef}
                {...(listeners || {})}
                aria-label={t('app_studio.canvas.move_aria', 'Drag to move · Alt+Arrow to reorder')}
                title={t('app_studio.canvas.move_title', 'Drag to move · Alt+↑/↓ to reorder')}
                className="ase-move-grip p-1 rounded cursor-grab active:cursor-grabbing"
                style={{ color: 'var(--editor-accent)', touchAction: 'none' }}
            >
                <GripVertical className="w-4 h-4" />
            </button>
            <IconButton size="sm" ariaLabel={t('app_studio.canvas.duplicate', 'Duplicate')} onClick={onDuplicate}>
                <Copy />
            </IconButton>
            <IconButton size="sm" variant="danger" ariaLabel={t('app_studio.canvas.delete', 'Delete')} onClick={onDelete}>
                <Trash2 />
            </IconButton>
        </div>
    );
}

interface ResizeGripsProps {
    resize: NodeResize;
    showWidth: boolean;
    showHeight: boolean;
}

/** WIDTH grip on the right edge (only where `span` is real); HEIGHT grip on the bottom (height-capable types only). */
export function ResizeGrips({ resize, showWidth, showHeight }: ResizeGripsProps) {
    const { t } = useTranslation();
    const { widthPreview, heightPreview, currentSpan, currentHeight } = resize;
    return (
        <>
            {showWidth ? (
                <div
                    role="slider"
                    aria-label={t('app_studio.canvas.resize_width', 'Resize width')}
                    aria-orientation="horizontal"
                    aria-valuemin={1}
                    aria-valuemax={12}
                    aria-valuenow={widthPreview ?? currentSpan}
                    tabIndex={0}
                    title={t('app_studio.canvas.resize_width_title', 'Drag to resize width · ←/→ to adjust')}
                    className="ase-resize-handle ase-resize-x"
                    style={{ touchAction: 'none' }}
                    {...resize.width}
                >
                    <span className="ase-resize-grip-x" aria-hidden="true" />
                    {widthPreview != null ? (
                        <span className="ase-resize-badge" aria-hidden="true">{widthPreview} / 12</span>
                    ) : null}
                </div>
            ) : null}
            {showHeight ? (
                <div
                    role="slider"
                    aria-label={t('app_studio.canvas.resize_height', 'Resize height')}
                    aria-orientation="vertical"
                    aria-valuetext={heightPreview ?? currentHeight}
                    tabIndex={0}
                    title={t('app_studio.canvas.resize_height_title', 'Drag to resize height · ↑/↓ to adjust')}
                    className="ase-resize-handle ase-resize-y"
                    style={{ touchAction: 'none' }}
                    {...resize.height}
                >
                    <span className="ase-resize-grip-y" aria-hidden="true" />
                    {heightPreview != null ? (
                        <span className="ase-resize-badge ase-resize-badge-y" aria-hidden="true">{heightPreview}</span>
                    ) : null}
                </div>
            ) : null}
        </>
    );
}
