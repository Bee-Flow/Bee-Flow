import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import useOutsideDismiss from '../../../../hooks/useOutsideDismiss';

/**
 * Lightweight click-outside-to-close popover anchored at an absolute
 * (clientX, clientY) — the natural shape for a right-click row menu.
 *
 * Caller controls visibility via the `position` prop:
 *   - position === null → closed
 *   - position === { x, y } → open at that viewport-relative point
 *
 * Items: `{ label, icon?, onClick, danger?, separator? }`. A separator
 * item just renders a hairline divider — no click handler.
 */
/** One row of the menu. A separator is a divider with no label or handler. */
export interface ContextMenuItem {
    label?: string;
    icon?: React.ReactNode;
    onClick?: () => void;
    danger?: boolean;
    separator?: boolean;
    shortcut?: string;
}

export interface ContextMenuPosition {
    x: number;
    y: number;
}

export default function ContextMenu({ position, items, onClose }: {
    position: ContextMenuPosition | null;
    items: ContextMenuItem[];
    onClose?: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);
    // Stable handle for the onClose callback. Caller doesn't have to
    // useCallback — we read through the ref so changing identity doesn't
    // re-install the document listeners on every parent render.
    const onCloseRef = useRef<(() => void) | undefined>(onClose);
    useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

    // Adjust position based on the menu's real rendered size so long labels
    // (translated strings, long automation names) don't overflow the viewport.
    const [shift, setShift] = useState({ x: 0, y: 0 });

    useOutsideDismiss(ref, () => onCloseRef.current?.(), { enabled: !!position, defer: false });

    useLayoutEffect(() => {
        if (!position || !ref.current) {
            setShift({ x: 0, y: 0 });
            return;
        }
        const rect = ref.current.getBoundingClientRect();
        const margin = 8;
        const overflowX = position.x + rect.width + margin - window.innerWidth;
        const overflowY = position.y + rect.height + margin - window.innerHeight;
        setShift({
            x: overflowX > 0 ? -overflowX : 0,
            y: overflowY > 0 ? -overflowY : 0,
        });
    }, [position, items]);

    if (!position) return null;

    return (
        <div
            ref={ref}
            className="fixed z-[2000] min-w-[200px] max-w-[320px] rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] shadow-xl py-1 text-sm"
            style={{ left: position.x + shift.x, top: position.y + shift.y }}
        >
            {items.map((item, i) => {
                if (item.separator) {
                    return <div key={`sep-${i}`} className="my-1 border-t border-[var(--border-default)]" />;
                }
                const key = item.label ? `item-${item.label}` : `idx-${i}`;
                return (
                    <button
                        key={key}
                        onClick={() => {
                            try { item.onClick?.(); }
                            catch (err) { console.error('[ContextMenu] item onClick error:', err); }
                            onClose?.();
                        }}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-left transition ${
                            item.danger
                                ? 'text-red-500 hover:bg-red-500/10'
                                : 'text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]'
                        }`}
                    >
                        {item.icon && <span className="flex-shrink-0">{item.icon}</span>}
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.shortcut && (
                            <span className="text-[10px] text-[var(--text-tertiary)] font-mono">{item.shortcut}</span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}
