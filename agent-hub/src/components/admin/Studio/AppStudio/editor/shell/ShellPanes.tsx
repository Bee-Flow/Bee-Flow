/**
 * The editor shell's two side columns: the AI chat pane on the left and the
 * inspector on the right, each collapsible and resizable, with its width and
 * open state remembered per user.
 */
import { PanelLeftClose, PanelRightClose, PanelRightOpen, Sparkles } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { ReactNode, SetStateAction } from 'react';
import useTranslation from '@/hooks/useTranslation';
import scopedStorage from '@/utils/scopedStorage';
import PanelResizerJs from '@/components/shared/PanelResizer';
import useContainerWidth from '@/components/shared/useContainerWidth';
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

// Below this the canvas column stops being a place to build in: at 1024px the
// Studio sidebar, the chat pane and the inspector left it ~240px, the app name
// read "Quote tr…" and the header controls stacked into a column.
export const MIN_CENTER = 480;
const RAIL_WIDTH = 40;

/**
 * Which side panes FLOAT over the canvas instead of sitting beside it, for a
 * shell this wide. The chat pane goes first (the inspector follows what is
 * selected, so it is the one you need beside the canvas); when even that is
 * not enough both float. `null` (not measured, jsdom) keeps both in place.
 */
export function floatingPanes(shellWidth: number | null, chatWidth: number, inspectorWidth: number) {
    if (shellWidth == null || shellWidth - chatWidth - inspectorWidth >= MIN_CENTER) return { chat: false, inspector: false };
    if (chatWidth > 0 && shellWidth - RAIL_WIDTH - inspectorWidth >= MIN_CENTER) return { chat: true, inspector: false };
    return { chat: chatWidth > 0, inspector: inspectorWidth > 0 };
}

type FloatingName = 'chat' | 'inspector';

/**
 * The two panes as the shell renders them. A pane in place is the remembered
 * one; a floating pane starts closed (a rail), opens over the canvas, and
 * only one floats open at a time. Its open state is not remembered: it is a
 * temporary look, the remembered choice still applies once there is room.
 */
export function useShellPanes(chat: SidePane, inspector: SidePane, floats: { chat: boolean; inspector: boolean }) {
    const [active, setActive] = useState<FloatingName | null>(null);
    const setFor = useCallback((name: FloatingName) => (value: SetStateAction<boolean>) => setActive((current) => {
        const isOpen = current === name;
        const next = typeof value === 'function' ? value(isOpen) : value;
        if (next) return name;
        return isOpen ? null : current;
    }), []);
    const setChat = useMemo(() => setFor('chat'), [setFor]);
    const setInspector = useMemo(() => setFor('inspector'), [setFor]);
    const toggleChat = useCallback(() => setChat((o) => !o), [setChat]);
    const toggleInspector = useCallback(() => setInspector((o) => !o), [setInspector]);
    const chatPane = useMemo(
        () => (floats.chat ? { ...chat, open: active === 'chat', setOpen: setChat, toggle: toggleChat } : chat),
        [floats.chat, chat, active, setChat, toggleChat],
    );
    const inspectorPane = useMemo(
        () => (floats.inspector ? { ...inspector, open: active === 'inspector', setOpen: setInspector, toggle: toggleInspector } : inspector),
        [floats.inspector, inspector, active, setInspector, toggleInspector],
    );
    return { chatPane, inspectorPane };
}

/**
 * Both side panes of the editor shell, measured against the shell: the
 * remembered ones, and the panes as rendered (in place or floating). The
 * inspector only counts while it is shown (`inspectorShown`).
 */
export function useEditorPanes(hasChat: boolean, inspectorShown: boolean) {
    const storedChat = useSidePane(CHAT);
    const storedInspector = useSidePane(INSPECTOR);
    const [shellRef, shellWidth] = useContainerWidth();
    const floats = floatingPanes(
        shellWidth,
        hasChat ? storedChat.width : 0,
        inspectorShown ? storedInspector.width : 0,
    );
    const { chatPane, inspectorPane } = useShellPanes(storedChat, storedInspector, floats);
    return { shellRef, floats, chatPane, inspectorPane };
}

// A floating pane: over the canvas, on an opaque surface (glass themes make
// --bg-primary transparent; data-surface="opaque" is their modal tier).
const FLOATING = 'absolute inset-y-0 z-30 bg-[var(--bg-secondary)] shadow-[var(--shadow-popover)]';

const RAIL = 'flex w-10 shrink-0 flex-col items-center pt-3 border-[var(--border-default)]';

interface ChatColumnProps {
    chatSlot: ReactNode;
    pane: SidePane;
    streamLock: boolean;
    /** Float over the canvas instead of taking a column (a narrow shell). */
    floating?: boolean;
}

/**
 * LEFT — AI chat pane (collapsible + resizable) or its rail. The open pane is
 * hidden with CSS rather than unmounted so the chat transcript — and a
 * streaming AI turn — survive a collapse.
 */
export function ChatColumn({ chatSlot, pane, streamLock, floating = false }: ChatColumnProps) {
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
                className={`${floating ? `${FLOATING} left-0` : 'relative'} shrink-0 flex-col border-r min-h-0 ${pane.open ? 'flex' : 'hidden'}`}
                data-surface={floating ? 'opaque' : undefined}
                style={{ width: floating ? `min(${pane.width}px, calc(100% - ${RAIL_WIDTH * 2}px))` : pane.width, borderColor: 'var(--border-default)' }}
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
            {pane.open && !floating ? (
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
                        className={`rounded-md p-1.5 hover:bg-[var(--bg-card-hover)] ${streamLock ? 'animate-pulse' : ''} ${streamLock ? '[color:var(--accent-primary)]' : '[color:var(--text-tertiary)]'}`}
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
    /** Float over the canvas instead of taking a column (a narrow shell). */
    floating?: boolean;
}

/**
 * RIGHT — the inspector, or its rail when collapsed. A fixed 320px column on
 * a 1920px screen is not a layout decision, it is the absence of one: it is
 * too narrow for a binding editor and too wide for a screen where you are
 * only nudging spans. Collapsing it gives the canvas 320px back, which on a
 * phone-shaped app preview is the difference between seeing the whole screen
 * and scrolling it.
 */
export function InspectorColumn({ pane, children, floating = false }: InspectorColumnProps) {
    const { t } = useTranslation();
    if (!pane.open || floating) {
        const rail = (
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
        if (!pane.open) return rail;
        return (
            <>
                {rail}
                <InspectorAside pane={pane} floating>{children}</InspectorAside>
            </>
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
            <InspectorAside pane={pane}>{children}</InspectorAside>
        </>
    );
}

/** The open inspector: in its column, or floating over the canvas. */
function InspectorAside({ pane, children, floating = false }: { pane: SidePane; children: ReactNode; floating?: boolean }) {
    const { t } = useTranslation();
    return (
        <aside
            aria-label={t('app_studio.shell.inspector', 'Inspector')}
            className={`${floating ? `${FLOATING} right-0` : ''} shrink-0 overflow-y-auto border-l min-h-0`}
            data-surface={floating ? 'opaque' : undefined}
            style={{ width: floating ? `min(${pane.width}px, calc(100% - ${RAIL_WIDTH * 2}px))` : pane.width, borderColor: 'var(--border-default)' }}
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
