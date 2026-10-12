import React, { useEffect, useRef, useState } from 'react';
import { LayoutGrid, ChevronDown, Rows3, Shrink, Expand } from 'lucide-react';
import useTranslation from '../../../../hooks/useTranslation';

/**
 * "Arrange ▾" in the south-west zone (design 1a): the three re-layouts
 * arrange.js offers, as a small menu that opens upward. Each one is a single
 * definition change and therefore one Ctrl+Z. Only rendered where the canvas
 * is the user's to edit — DiagramPane gates it on `allowEdgeEdits`.
 */
export default function ArrangeMenu({ onArrange }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    useEffect(() => {
        if (!open) return undefined;
        const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDoc, true);
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('mousedown', onDoc, true); document.removeEventListener('keydown', onKey); };
    }, [open]);
    const pick = (mode) => { setOpen(false); onArrange?.(mode); };
    const items = [
        { mode: 'serpentine', Icon: Rows3, label: t('automations.canvas.arrange_rows', 'Rows that fit the screen') },
        { mode: 'compact', Icon: Shrink, label: t('automations.canvas.arrange_compact', 'One tight line') },
        { mode: 'roomy', Icon: Expand, label: t('automations.canvas.arrange_roomy', 'Roomy, with flowlets open') },
    ];
    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                className="inline-flex items-center gap-1.5 px-2.5 py-[6px] rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)] shadow-sm text-[12px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
            >
                <LayoutGrid size={14} /> {t('automations.canvas.arrange', 'Arrange')} <ChevronDown size={12} className="text-[var(--text-tertiary)]" />
            </button>
            {open && (
                <div role="menu" className="absolute left-0 bottom-full mb-1 z-40 w-56 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] py-1" style={{ boxShadow: 'var(--shadow-popover)' }}>
                    {items.map(({ mode, Icon, label }) => (
                        <button
                            key={mode}
                            role="menuitem"
                            type="button"
                            onClick={() => pick(mode)}
                            className="w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition"
                        >
                            <Icon size={13} className="text-[var(--text-secondary)]" /> {label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
