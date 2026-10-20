import React, { useEffect, useId, useRef, useState } from 'react';
import { CircleHelp } from 'lucide-react';

interface HelpPopoverProps {
    /** The button's accessible name. */
    label: string;
    children: React.ReactNode;
}

/** A "?" that opens a short plain-language explanation; Escape or a click elsewhere closes it. */
export default function HelpPopover({ label, children }: HelpPopoverProps) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLSpanElement>(null);
    const id = useId();

    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    return (
        <span ref={root} className="relative inline-flex">
            <button
                type="button"
                aria-label={label}
                aria-expanded={open}
                aria-controls={open ? id : undefined}
                onClick={() => setOpen(o => !o)}
                className="p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
                <CircleHelp size={14} aria-hidden />
            </button>
            {open && (
                <span id={id} role="note" className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] p-3 text-xs font-normal leading-relaxed text-[var(--text-secondary)] shadow-lg">
                    {children}
                </span>
            )}
        </span>
    );
}
