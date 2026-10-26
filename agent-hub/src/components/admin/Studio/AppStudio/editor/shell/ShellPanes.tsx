/**
 * The editor shell's two side columns: the AI chat pane on the left and the
 * inspector on the right, each collapsible and resizable, with its width and
 * open state remembered per user.
 */
import { PanelLeftClose, PanelRightClose, PanelRightOpen, Sparkles } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import useTranslation from '@/hooks/useTranslation';
import scopedStorage from '@/utils/scopedStorage';
import PanelResizerJs from '@/components/shared/PanelResizer';
import type { ActiveDrag } from './useCanvasDrag';

const PanelResizer = PanelResizerJs;

// Inspector column. 260px still fits a label+control row; 560px is where a
// binding editor stops needing its own scrollbar.
export const INSPECTOR = { widthKey: 'appStudioInspectorWidth', openKey: 'appStudioInspectorOpen', defaultWidth: 320, min: 260, max: 560 };

// Chat column. 280px keeps the composer usable; past 480px the pane starts
// costing the canvas more than a chat transcript is worth.
export const CHAT = { widthKey: 'appStudioChatWidth', openKey: 'appStudioChatOpen', defaultWidth: 340, min: 280, max: 480 };

/** A side column's remembered width and open state. */
export function useSidePane(pane: { widthKey: string; openKey: string; defaultWidth: number }) {
    const [width, setWidth] = useState(
        () => parseInt(scopedStorage.getItem(pane.widthKey) as string, 10) || pane.defaultWidth,
    );
    const [open, setOpen] = useState(
        () => scopedStorage.getItem(pane.openKey) !== '0',
    );
    const persistWidth = useCallback((w: number) => {
        scopedStorage.setItem(pane.widthKey, String(w));
    }, [pane.widthKey]);
    const toggle = useCallback(() => {
        setOpen((o) => {
            scopedStorage.setItem(pane.openKey, o ? '0' : '1');
            return !o;
        });
    }, [pane.openKey]);
    return { width, setWidth, open, setOpen, persistWidth, toggle };
}

export type SidePane = ReturnType<typeof useSidePane>;

const RAIL = 'flex w-10 shrink-0 flex-col items-center pt-3 border-[var(--border-default)]';

interface ChatColumnProps {
    chatSlot: ReactNode;
    pane: SidePane;
    streamLock: boolean;
}

/**
 * LEFT — AI chat pane (collapsible + resizable) or its rail. The open pane is
 * hidden with CSS rather than unmounted so the chat transcript — and a
 * streaming AI turn — survive a collapse.
 */
export function ChatColumn({ chatSlot, pane, streamLock }: ChatColumnProps) {
    const { t } = useTranslation();
    if (!chatSlot) {
        return (
            <aside className={`${RAIL} border-r`} aria-label={t('app_studio.shell.ai_soon_aria', 'AI assistant (coming soon)')}>
                <span className="rounded-md p-1.5 text-[var(--text-tertiary)]" title={t('app_studio.shell.ai_soon', 'AI assistant — coming soon')}>
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                </span>
            </aside>
        );
    }
    return (
        <>
            <aside
                aria-label={t('app_studio.shell.ai_builder', 'AI builder')}
                className={`relative shrink-0 flex-col border-r min-h-0 ${pane.open ? 'flex' : 'hidden'}`}
                style={{ width: pane.width, borderColor: 'var(--border-default)' }}
            >
                {/* Shell-owned collapse control, overlaid on the pane
                    header's empty right side — the slot stays opaque. */}
                <button
                    type="button"
                    onClick={pane.toggle}
                    aria-label={t('app_studio.shell.ai_hide', 'Hide the AI builder')}
                    title={t('app_studio.shell.ai_hide', 'Hide the AI builder')}
                    className="absolute right-1.5 top-1.5 z-10 rounded-md p-1.5 hover:bg-[var(--bg-card-hover)] text-[var(--text-tertiary)]"
                >
                    <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
                </button>
                {chatSlot}
            </aside>
            {pane.open ? (
                <PanelResizer
                    width={pane.width}
                    min={CHAT.min}
                    max={CHAT.max}
                    defaultWidth={CHAT.defaultWidth}
                    edge="start"
                    onResize={pane.setWidth}
                    onResizeEnd={pane.persistWidth}
                    label={t('app_studio.shell.ai_resize', 'Resize the AI builder pane')}
                />
            ) : (
                <aside className={`${RAIL} border-r`}>
                    <button
                        type="button"
                        onClick={pane.toggle}
                        aria-label={t('app_studio.shell.ai_show', 'Show the AI builder')}
                        title={streamLock
                            ? t('app_studio.shell.ai_building', 'The AI is building — click to watch')
                            : t('app_studio.shell.ai_show', 'Show the AI builder')}
                        className={`rounded-md p-1.5 hover:bg-[var(--bg-card-hover)] ${streamLock ? 'animate-pulse' : ''}`}
                        style={{ color: streamLock ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}
                    >
                        <Sparkles className="h-4 w-4" aria-hidden="true" />
                    </button>
                </aside>
            )}
        </>
    );
}

interface InspectorColumnProps {
    pane: SidePane;
    /** The InspectorPanel — rendered by the shell, which already imports it. */
    children: ReactNode;
}

/**
 * RIGHT — the inspector, or its rail when collapsed. A fixed 320px column on
 * a 1920px screen is not a layout decision, it is the absence of one: it is
 * too narrow for a binding editor and too wide for a screen where you are
 * only nudging spans. Collapsing it gives the canvas 320px back, which on a
 * phone-shaped app preview is the difference between seeing the whole screen
 * and scrolling it.
 */
export function InspectorColumn({ pane, children }: InspectorColumnProps) {
    const { t } = useTranslation();
    if (!pane.open) {
        return (
            <aside className={`${RAIL} border-l`}>
                <button
                    type="button"
                    onClick={pane.toggle}
                    aria-label={t('app_studio.shell.inspector_show', 'Show the inspector')}
                    title={t('app_studio.shell.inspector_show', 'Show the inspector')}
                    className="rounded-md p-1.5 hover:bg-[var(--bg-card-hover)] text-[var(--text-tertiary)]"
                >
                    <PanelRightOpen className="h-4 w-4" aria-hidden="true" />
                </button>
            </aside>
        );
    }
    return (
        <>
            <PanelResizer
                width={pane.width}
                min={INSPECTOR.min}
                max={INSPECTOR.max}
                defaultWidth={INSPECTOR.defaultWidth}
                edge="end"
                onResize={pane.setWidth}
                onResizeEnd={pane.persistWidth}
                label={t('app_studio.shell.inspector_resize', 'Resize the inspector')}
            />
            <aside
                aria-label={t('app_studio.shell.inspector', 'Inspector')}
                className="shrink-0 overflow-y-auto border-l min-h-0"
                style={{ width: pane.width, borderColor: 'var(--border-default)' }}
            >
                <div className="flex justify-end px-2 pt-2">
                    <button
                        type="button"
                        onClick={pane.toggle}
                        aria-label={t('app_studio.shell.inspector_collapse', 'Collapse the inspector')}
                        title={t('app_studio.shell.inspector_collapse', 'Collapse the inspector')}
                        className="rounded-md p-1 hover:bg-[var(--bg-card-hover)] text-[var(--text-tertiary)]"
                    >
                        <PanelRightClose className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>
                {children}
            </aside>
        </>
    );
}

/** The DragOverlay chip. */
export function DragChip({ label, Icon }: ActiveDrag) {
    return (
        <div
            className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium shadow-lg bg-[var(--bg-secondary)] border-[var(--accent-primary)] text-[var(--text-primary)]"
        >
            {Icon ? <Icon className="h-3.5 w-3.5 text-[var(--accent-primary)]" aria-hidden="true" /> : null}
            {label}
        </div>
    );
}
