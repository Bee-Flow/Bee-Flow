import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import useOutsideDismiss from '../../../../hooks/useOutsideDismiss';

/**
 * Minimal TopBar dropdown: trigger + anchored panel with click-outside and
 * Escape to close. No portal — the TopBar sits at the top of the builder
 * with nothing clipping descendants, so absolute positioning is enough.
 *
 * `trigger` is a render-prop receiving `{ open }` so triggers can flip their
 * chevron; `align` anchors the panel to the trigger's left or right edge.
 */
interface DropdownProps {
    trigger: (state: { open: boolean }) => ReactNode;
    children: (state: { close: () => void }) => ReactNode;
    align?: 'left' | 'right';
    width?: number;
    panelClassName?: string;
    onOpenChange?: (open: boolean) => void;
}

export default function Dropdown({ trigger, children, align = 'left', width = 288, panelClassName = '', onOpenChange }: DropdownProps) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    useOutsideDismiss(rootRef, () => setOpen(false), { enabled: open, defer: false });

    useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);

    return (
        <div ref={rootRef} className="relative">
            <div onClick={() => setOpen(o => !o)}>{trigger({ open })}</div>
            {open && (
                <div
                    className={`absolute z-40 mt-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] shadow-xl ${align === 'right' ? 'right-0' : 'left-0'} ${panelClassName}`}
                    style={{ width, top: '100%' }}
                >
                    {children({ close: () => setOpen(false) })}
                </div>
            )}
        </div>
    );
}
