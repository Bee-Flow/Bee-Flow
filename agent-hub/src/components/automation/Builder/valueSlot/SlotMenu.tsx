import { useRef, useState } from 'react';
import { MoreHorizontal, SquareFunction, Workflow } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import AnchoredMenuJs from '../../../shared/AnchoredMenu';
import type { ComponentType, ReactNode, RefObject } from 'react';

// The menu primitive is untyped JS; its props are checked there.
const AnchoredMenu = AnchoredMenuJs as unknown as ComponentType<{
    open: boolean;
    onClose: () => void;
    anchorRef: RefObject<HTMLElement | null>;
    align?: string;
    minWidth?: number;
    role?: string;
    className?: string;
    children?: ReactNode;
}>;

const item = 'w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left rounded-md text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition';

/**
 * A value slot's small ⋯ beside the field: the ways in that are not typing
 * or a click in "Comes in". "Use data from a step" opens the picker (for
 * whoever has no Comes in column, or uses a keyboard); "Formula" opens
 * Advanced › Formula. Both used to sit as links under every field, empty
 * ones included, which made a form of five fields read like a control panel.
 */
export default function SlotMenu({ label, pickLabel, onPick, onFormula }: {
    label?: string | null;
    /** The first item's words: "Use data from a step", or "Add a value from a step" in a text with values. */
    pickLabel: string;
    onPick: (anchor: Element | null) => void;
    /** Absent when this value has no formula spelling, or formulas are not offered here. */
    onFormula?: (() => void) | null;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLButtonElement | null>(null);
    const field = label || t('mapping.slot.advanced.this_value', 'this value');
    const name = t('mapping.slot.more', 'More ways to fill {field}', { field });
    const formulaName = t('mapping.slot.advanced.formula_for', 'Write {field} as a formula', { field });
    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={name}
                title={name}
                data-testid="slot-menu"
                className="shrink-0 w-6 h-6 mt-[3px] grid place-items-center rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition"
            >
                <MoreHorizontal size={14} aria-hidden="true" />
            </button>
            <AnchoredMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={anchorRef}
                align="right"
                minWidth={200}
                role="menu"
                className="p-1 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] shadow-lg"
            >
                <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setOpen(false); onPick(anchorRef.current); }}
                    className={item}
                >
                    <Workflow size={13} aria-hidden="true" />
                    {pickLabel}
                </button>
                {onFormula && (
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => { setOpen(false); onFormula(); }}
                        title={formulaName}
                        data-testid="slot-formula-open"
                        className={item}
                    >
                        <SquareFunction size={13} aria-hidden="true" />
                        {t('mapping.slot.advanced.formula', 'Formula')}
                    </button>
                )}
            </AnchoredMenu>
        </>
    );
}
